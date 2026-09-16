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

    $tabla.find('tr').each((__, fila) => {
      const celdas = $(fila).children('td');
      if (celdas.length < 3) return;
      const t = celdas.map((___, td) => $(td).text().trim()).get();
      const nombreEquipo = t[1] || t[0];
      const textoCompleto = t.join(' ');
      if (!nombreEquipo) return;

      // Busca un patrón tipo "W3", "3W", "Won 3", "L2", etc.
      const matchRacha = textoCompleto.match(/\b([WDL])\s?-?\s?(\d{1,2})\b|\b(\d{1,2})\s?-?\s?([WDL])\b/i);
      if (!matchRacha) return;
      const tipo = (matchRacha[1] || matchRacha[4] || '').toUpperCase();
      const longitud = parseInt(matchRacha[2] || matchRacha[3], 10);
      if (!tipo || !longitud) return;

      equipos[normalizar(nombreEquipo)] = {
        nombreOriginal: nombreEquipo,
        rachaTipo: tipo, // W, D o L
        rachaLongitud: longitud,
      };
    });
  });
  return equipos;
}

// ---------- 6. Primer tiempo (halftime.asp) — mejor esfuerzo ----------
function parsearPrimerTiempo($) {
  const equipos = {};
  $('table').each((_, tabla) => {
    const $tabla = $(tabla);
    const headerTexto = $tabla.text();
    if (!headerTexto.includes('HT') && !headerTexto.toLowerCase().includes('half')) return;
    if (Object.keys(equipos).length > 0) return;

    $tabla.find('tr').each((__, fila) => {
      const celdas = $(fila).children('td');
      if (celdas.length < 6) return;
      const t = celdas.map((___, td) => $(td).text().trim()).get();
      const nombreEquipo = t[1];
      const numeros = t.slice(2).map(num).filter((n) => n !== null);
      if (!nombreEquipo || numeros.length < 3) return;

      equipos[normalizar(nombreEquipo)] = {
        nombreOriginal: nombreEquipo,
        // Mejor esfuerzo: primeros números tras el nombre suelen ser GP/W/D/L del HT
        htGolesFavorAprox: numeros[numeros.length - 2] ?? null,
        htGolesContraAprox: numeros[numeros.length - 1] ?? null,
      };
    });
  });
  return equipos;
}

// ---------- Próximos partidos (latest.asp) ----------
// IMPORTANTE: en la sección "Statistics" de latest.asp, el equipo local y el
// visitante quedan en FILAS SEPARADAS de la tabla (no en la misma fila), así
// que reconstruir "local+visita" a partir del texto de la fila que contiene
// el link fallaba siempre (esto era el bug que hacía que no saliera ningún
// partido). La solución: cada enlace a pmatch.asp trae el emparejamiento
// correcto y confiable en su atributo title, con formato "Equipo A vs Equipo B".
function parsearProximosPartidos($) {
  const partidos = [];
  const vistos = new Set(); // evita duplicados: el mismo partido puede aparecer en 2 secciones de la página

  $('a[href*="pmatch.asp"]').each((_, enlace) => {
    const $enlace = $(enlace);
    const title = $enlace.attr('title') || '';
    const matchEquipos = title.match(/^(.+?)\s+vs\s+(.+)$/i);
    if (!matchEquipos) return;
    const [, local, visita] = matchEquipos;

    // Buscamos la fecha/hora ampliando el contenedor hasta encontrarla
    // (fila propia, luego fila anterior/tabla completa como respaldo).
    let contenedor = $enlace.closest('tr').length ? $enlace.closest('tr') : $enlace.parent();
    let texto = contenedor.text();
    let matchFechaHora = texto.match(/([A-Za-z]{2,3})\s+(\d{1,2})\s+([A-Za-z]{3})\D{0,8}(\d{1,2}:\d{2})/);

    if (!matchFechaHora) {
      // Respaldo: a veces la fecha está en una celda/fila hermana anterior
      const contenedorAmplio = contenedor.parent();
      texto = contenedorAmplio.text();
      matchFechaHora = texto.match(/([A-Za-z]{2,3})\s+(\d{1,2})\s+([A-Za-z]{3})\D{0,8}(\d{1,2}:\d{2})/);
    }
    if (!matchFechaHora) return;

    const [, , diaNum, mesAbrev, hora] = matchFechaHora;
    const clave = `${local}|${visita}|${diaNum}${mesAbrev}${hora}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);

    partidos.push({ diaNum: parseInt(diaNum, 10), mesAbrev, hora, local: local.trim(), visita: visita.trim() });
  });
  return partidos;
}

function aFechaISO(diaNum, mesAbrev, hora) {
  const meses = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mes = meses[mesAbrev.toLowerCase().slice(0, 3)];
  if (mes === undefined) return null;
  const ahora = new Date();
  let anio = ahora.getFullYear();
  const fechaTentativa = new Date(Date.UTC(anio, mes, diaNum));
  if ((fechaTentativa - ahora) / (1000 * 60 * 60 * 24) < -60) anio += 1;
  const [h, m] = hora.split(':').map(Number);
  return new Date(Date.UTC(anio, mes, diaNum, h, m)).toISOString();
}

// ---------- Orquestación por liga ----------

async function fetchOpcional(url, parser, contexto) {
  try {
    const html = await obtenerHtml(url);
    return parser(cheerio.load(html));
  } catch (e) {
    console.warn(`  [${contexto}] fallo: ${e.message}`);
    return {};
  }
}

async function procesarLiga(liga) {
  let htmlLatest;
  try {
    htmlLatest = await obtenerHtml(`https://www.soccerstats.com/latest.asp?league=${liga.slug}`);
  } catch (e) {
    console.warn(`[${liga.name}] fallo latest.asp: ${e.message}`);
    return { equipos: {}, partidos: [] };
  }

  await esperar(PAUSA_MS);
  let htmlWidetable = '';
  try {
    htmlWidetable = await obtenerHtml(`https://www.soccerstats.com/widetable.asp?league=${liga.slug}`);
  } catch (e) {
    console.warn(`  [widetable] fallo: ${e.message}`);
  }

  const widetable = parsearWidetable(cheerio.load(htmlWidetable));
  const partidosCrudos = parsearProximosPartidos(cheerio.load(htmlLatest));

  await esperar(PAUSA_MS);
  const overUnder = await fetchOpcional(`https://www.soccerstats.com/table.asp?league=${liga.slug}&tid=c`, parsearOverUnder, 'over/under');

  await esperar(PAUSA_MS);
  const rachas = await fetchOpcional(`https://www.soccerstats.com/table.asp?league=${liga.slug}&tid=g`, parsearRachas, 'rachas');

  await esperar(PAUSA_MS);
  let htmlHalftime = '';
  try {
    htmlHalftime = await obtenerHtml(`https://www.soccerstats.com/halftime.asp?league=${liga.slug}`);
  } catch (e) {
    console.warn(`  [primer tiempo] fallo: ${e.message}`);
  }
  const primerTiempo = htmlHalftime ? parsearPrimerTiempo(cheerio.load(htmlHalftime)) : {};
  const overUnderHT = htmlHalftime ? parsearOverUnderPrimerTiempo(cheerio.load(htmlHalftime)) : {};

  const equipos = {};
  for (const clave of Object.keys(widetable)) {
    equipos[clave] = {
      ...widetable[clave],
      ...(overUnder[clave] || {}),
      ...(rachas[clave] || {}),
      ...(primerTiempo[clave] || {}),
      ...(overUnderHT[clave] || {}),
    };
  }

  return {
    equipos,
    partidos: partidosCrudos.map((p) => ({
      fechaISO: aFechaISO(p.diaNum, p.mesAbrev, p.hora),
      local: p.local,
      visita: p.visita,
    })),
  };
}

async function main() {
  console.log(`Node ${process.version} — abriendo navegador (Puppeteer)...`);
  await iniciarNavegador();

  try {
    console.log('Probando conexión a SoccerStats.com...');
    try {
      await obtenerHtml('https://www.soccerstats.com/');
      const prueba = await obtenerHtml('https://www.soccerstats.com/leagues.asp');
      console.log(`Conexión OK (recibidos ${prueba.length} caracteres de HTML).\n`);
    } catch (e) {
      console.error('\n========================================================');
      console.error('ERROR: no se pudo conectar a soccerstats.com ni con un navegador real.');
      console.error(`Detalle: ${e.message}`);
      console.error('Esto sugiere una protección anti-bot más fuerte de lo que');
      console.error('este script puede sortear (ej. captcha visual), o un');
      console.error('bloqueo de tu IP específicamente para tráfico automatizado.');
      console.error('========================================================\n');
      process.exit(1);
    }

    const ligasResultado = {};

    for (const liga of leagues) {
      console.log(`Procesando ${liga.name} (${liga.slug})...`);
      let datos;
      try {
        datos = await procesarLiga(liga);
      } catch (e) {
        console.warn(`  [${liga.name}] se saltó por error inesperado: ${e.message}`);
        datos = { equipos: {}, partidos: [] };
      }
      ligasResultado[liga.slug] = { nombre: liga.name, region: liga.region, ...datos };
      console.log(`  -> ${Object.keys(datos.equipos).length} equipos, ${datos.partidos.length} partidos`);
      await esperar(PAUSA_MS);

      // Guarda un respaldo parcial tras cada liga, así si el proceso se corta
      // más adelante por cualquier motivo, no se pierde todo lo ya avanzado.
      const outPath = path.join(__dirname, '..', 'public', 'data', 'soccerstats.json');
      fs.writeFileSync(outPath, JSON.stringify({ generadoEn: new Date().toISOString(), ligas: ligasResultado }, null, 2));

      // Cada cierto número de ligas, reiniciamos el navegador. Tras cientos
      // de páginas seguidas, Chrome tiende a "cansarse" (fugas de memoria,
      // sesiones CDP colgadas) y empieza a fallar en cadena — reiniciarlo
      // de vez en cuando le da un respiro y evita rachas largas de fallos.
      ligasProcesadasDesdeReinicio++;
      if (ligasProcesadasDesdeReinicio >= LIGAS_ANTES_DE_REINICIAR) {
        console.log('  [info] reiniciando el navegador para liberar memoria...');
        await cerrarNavegador();
        await iniciarNavegador();
        ligasProcesadasDesdeReinicio = 0;
      }
    }

    console.log('Guardado completo en public/data/soccerstats.json');
  } finally {
    await cerrarNavegador();
  }
}

main().catch(async (e) => {
  console.error('Fallo fatal en fetch-soccerstats.js:', e);
  await cerrarNavegador();
  process.exit(1);
});
