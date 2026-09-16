/**
 * Para cada liga en config/leagues.js, descarga de SoccerStats.com:
 *   1. latest.asp?league=X       -> próximos partidos (calendario)
 *   2. widetable.asp?league=X    -> GP/W/D/L/PPG total + split local/visita (Wh,Dh,Lh,Wa,Da,La...)
 *   3. table.asp?league=X&tid=c  -> % Over 1.5/2.5/3.5 y BTTS por equipo
 *   4. table.asp?league=X&tid=g  -> racha actual (tipo y longitud) por equipo
 *   5. halftime.asp?league=X     -> resultados y goles al descanso, por equipo
 *
 * (Se quitaron corners y goleadores: SoccerStats no publica esas páginas para
 * la mayoría de ligas, así que daban 404 casi siempre y no aportaban valor.)
 *
 * SoccerStats.com bloquea peticiones HTTP simples (fetch/curl) con un 403,
 * incluso con encabezados de navegador — su protección detecta que no es un
 * navegador real. Por eso este script usa Puppeteer + un plugin "stealth"
 * (controla una ventana de Chrome real, invisible, ocultando las señales que
 * delatan automatización) en vez de fetch() directo. Esto es más lento (cada
 * página tarda unos segundos) y la primera vez que instales el proyecto,
 * `npm install` va a descargar Chromium (~200 MB) — es normal, solo pasa una vez.
 *
 * AVISO: no pude probar los selectores de parseo contra el HTML real en vivo
 * desde mi entorno. Las páginas 2 y 3 (widetable y over/under) están
 * verificadas contra contenido real. Las páginas 4 y 5 (rachas, primer
 * tiempo) son un parseo de mejor esfuerzo: si ves resultados vacíos ahí, son
 * las primeras que hay que revisar contra el HTML real y ajustar.
 *
 * Con 5 peticiones por liga y cada una pasando por un navegador real,
 * activar las ~150 ligas de golpe puede tardar bastante (más de una hora).
 * Es más seguro empezar con pocas ligas activas en config/leagues.js hasta
 * confirmar que todo funciona.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const leagues = require('../config/leagues');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const PAUSA_MS = 500;
const LIGAS_ANTES_DE_REINICIAR = 20;
let ligasProcesadasDesdeReinicio = 0;

// Red de seguridad: Puppeteer a veces lanza errores internos (ej. tiempos de
// espera del protocolo CDP) que no pasan por el try/catch normal de una
// función async — son "unhandled rejections" que, sin esto, tumban TODO el
// proceso de Node de golpe (como pasó con Argentina Clausura). Con esto,
// simplemente lo registramos y seguimos con la siguiente liga.
process.on('unhandledRejection', (err) => {
  console.warn(`  [aviso] error interno de Puppeteer ignorado, se continúa: ${err?.message || err}`);
});

let navegador = null;

async function iniciarNavegador() {
  navegador = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 120000, // 120s en vez del default (~30s), para que páginas lentas no exploten el proceso
  });
}

async function cerrarNavegador() {
  if (navegador) await navegador.close();
}

async function obtenerHtml(url) {
  const pagina = await navegador.newPage();
  try {
    await pagina.setUserAgent(USER_AGENT);
    await pagina.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,es-ES;q=0.8,es;q=0.7' });
    await pagina.setViewport({ width: 1366, height: 900 });

    const respuesta = await pagina.goto(url, {
      waitUntil: 'networkidle2', // espera a que la red esté prácticamente quieta, no solo al primer DOM (por si hay una redirección de JS)
      timeout: 45000,
      referer: 'https://www.soccerstats.com/',
    });
    if (!respuesta) throw new Error(`Sin respuesta al navegar a ${url}`);
    if (!respuesta.ok()) throw new Error(`HTTP ${respuesta.status()} en ${url}`);

    // Espera extra por si aún hay una redirección/verificación en curso.
    await new Promise((r) => setTimeout(r, 2500));

    const html = await pagina.content();

    // Si después de todo esto seguimos con una página casi vacía, algo la
    // está vaciando (redirección, bloqueo silencioso) — lo dejamos constar
    // en el propio error para que se vea claro en la consola.
    if (html.length < 500) {
      throw new Error(`Respuesta sospechosamente corta (${html.length} caracteres) en ${url} — URL final tras navegar: ${pagina.url()}`);
    }

    return html;
  } finally {
    await pagina.close();
  }
}

function num(texto) {
  if (texto === undefined || texto === null) return null;
  const limpio = String(texto).replace('%', '').replace(/[^\d.+-]/g, '');
  const n = parseFloat(limpio);
  return isNaN(n) ? null : n;
}

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 1. Tabla ancha con desglose casa/fuera (widetable.asp) ----------
// En vez de asumir una posición fija de columna (que varía entre ligas y
// causaba lecturas erróneas, como PPG mostrando "18" en vez de un valor
// entre 0 y 3), esta versión lee primero la fila de encabezado real de la
// tabla y busca cada columna por su nombre exacto (GP, W, D, L, PPGh, etc.),
// sin importar en qué posición esté en cada liga.
function parsearWidetable($) {
  const equipos = {};

  $('table').each((_, tabla) => {
    const $tabla = $(tabla);
    const headerTexto = $tabla.text();
    if (!headerTexto.includes('PPGh') || !headerTexto.includes('PPGa')) return;

    let indices = null;

    $tabla.find('tr').each((__, fila) => {
      const celdas = $(fila).children('td, th');
      if (celdas.length < 15) return;
      const t = celdas.map((___, td) => $(td).text().trim()).get();

      // La fila de encabezado es la que trae literalmente las etiquetas de columna
      if (!indices) {
        if (t.includes('PPGh') && t.includes('PPGa')) {
          indices = {};
          t.forEach((texto, i) => {
            if (!(texto in indices)) indices[texto] = i; // primera columna con ese nombre exacto
          });
        }
        return; // esta fila es el encabezado, no un equipo — pasa a la siguiente
      }

      const iTeam = indices['Team'] ?? 1;
      const iGP = indices['GP'];
      if (iGP === undefined) return;

      const nombreEquipo = t[iTeam];
      const gp = num(t[iGP]);
      if (!nombreEquipo || !gp) return;

      equipos[normalizar(nombreEquipo)] = {
        nombreOriginal: nombreEquipo,
        gp,
        w: num(t[indices['W']]), d: num(t[indices['D']]), l: num(t[indices['L']]),
        gf: num(t[indices['GF']]), ga: num(t[indices['GA']]),
        pts: num(t[indices['Pts']]), ppg: num(t[indices['PPG']]),
        wh: num(t[indices['Wh']]), dh: num(t[indices['Dh']]), lh: num(t[indices['Lh']]),
        gfh: num(t[indices['GFh']]), gah: num(t[indices['GAh']]),
        ppgh: num(t[indices['PPGh']]), ppga: num(t[indices['PPGa']]),
        wa: num(t[indices['Wa']]), da: num(t[indices['Da']]), la: num(t[indices['La']]),
        gfa: num(t[indices['GFa']]), gaa: num(t[indices['GAa']]),
      };
    });
  });

  return equipos;
}

// ---------- 2. Over/Under + BTTS por equipo (table.asp?tid=c) ----------
function parsearOverUnder($) {
  const equipos = {};
  $('table').each((_, tabla) => {
    const $tabla = $(tabla);
    if (!$tabla.text().includes('BTS') || !$tabla.text().includes('2.5+')) return;
    if (Object.keys(equipos).length > 0) return;

    $tabla.find('tr').each((__, fila) => {
      const celdas = $(fila).children('td');
      if (celdas.length < 10) return;
      const t = celdas.map((___, td) => $(td).text().trim()).get();
      const nombreEquipo = t[0];
      const gp = num(t[1]);
      if (!nombreEquipo || !gp) return;

      equipos[normalizar(nombreEquipo)] = {
        nombreOriginal: nombreEquipo,
        over05: num(t[3]), over15: num(t[4]), over25: num(t[5]), over35: num(t[6]), btts: num(t[9]),
      };
    });
  });
  return equipos;
}

// ---------- 3b. Over/Under de PRIMER TIEMPO (halftime.asp) — mejor esfuerzo ----------
// Usa la misma estructura de tabla que el over/under de partido completo,
// pero buscada dentro de la página de medio tiempo. No pude confirmar en
// vivo si esta página trae esta tabla exacta para todas las ligas — si sale
// vacío, es la primera candidata a revisar contra el HTML real.
function parsearOverUnderPrimerTiempo($) {
  const equipos = {};
  $('table').each((_, tabla) => {
    const $tabla = $(tabla);
    if (!$tabla.text().includes('BTS') || !$tabla.text().includes('2.5+')) return;
    if (Object.keys(equipos).length > 0) return;

    $tabla.find('tr').each((__, fila) => {
      const celdas = $(fila).children('td');
      if (celdas.length < 10) return;
      const t = celdas.map((___, td) => $(td).text().trim()).get();
      const nombreEquipo = t[0];
      const gp = num(t[1]);
      if (!nombreEquipo || !gp) return;

      equipos[normalizar(nombreEquipo)] = {
        nombreOriginal: nombreEquipo,
        over05HT: num(t[3]), over15HT: num(t[4]), over25HT: num(t[5]),
      };
    });
  });
  return equipos;
}

// ---------- 3. Rachas actuales (table.asp?tid=g) — mejor esfuerzo ----------
function parsearRachas($) {
  const equipos = {};
  $('table').each((_, tabla) => {
    const $tabla = $(tabla);
    const headerTexto = $tabla.text().toLowerCase();
    if (!headerTexto.includes('streak')) return;
    if (Object.keys(equipos).length > 0) return;
