const fs = require('fs');
const path = require('path');
const thresholds = require('../config/thresholds');

const ZONA_HORARIA = 'America/Guayaquil';

function leer(pathRelativo) {
  const p = path.join(__dirname, '..', 'public', 'data', pathRelativo);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function fechaEC(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date(iso));
}

// Antes calculaba "mañana" porque el robot corría de madrugada (4am) y se
// quería mostrar el día siguiente durante toda la jornada. Ahora el robot
// corre justo después de medianoche en Ecuador, así que el "día a mostrar"
// es simplemente HOY (el día que acaba de empezar en el momento de la corrida).
function fechaDeHoy() {
  return fechaEC(new Date().toISOString());
}

function promedio(...valores) {
  const validos = valores.filter((v) => v !== null && v !== undefined);
  if (!validos.length) return null;
  return Math.round((validos.reduce((a, b) => a + b, 0) / validos.length) * 10) / 10;
}

// Respaldo: si SoccerStats no trae el PPG ya calculado con esa etiqueta
// exacta para alguna liga, lo calculamos nosotros con la fórmula estándar
// (ganados×3 + empatados×1) / partidos jugados — así nunca queda en blanco
// aunque falte la columna con ese nombre exacto en el sitio.
function calcularPPG(w, d, l) {
  const gp = (w || 0) + (d || 0) + (l || 0);
  if (!gp) return null;
  return Math.round((((w || 0) * 3 + (d || 0)) / gp) * 100) / 100;
}

/**
 * Fórmula 1X2 "L/V", usando el desglose de LOCAL-EN-CASA y VISITA-FUERA de
 * widetable.asp (Wh/Dh/Lh del equipo local, Wa/Da/La del equipo visita):
 *
 *   Total  = GPh_local (partidos en casa) + GPa_visita (partidos fuera)
 *   Local  = (Ganados_local_en_casa + Perdidos_visita_fuera) / Total
 *   Empate = (Empatados_local_en_casa + Empatados_visita_fuera) / Total
 *   Visita = (Ganados_visita_fuera + Perdidos_local_en_casa) / Total
 */
function calcular1X2LV(local, visita) {
  if (!local || !visita) return { probLocal: null, probEmpate: null, probVisita: null };
  const gpHLocal = (local.wh || 0) + (local.dh || 0) + (local.lh || 0);
  const gpAVisita = (visita.wa || 0) + (visita.da || 0) + (visita.la || 0);
  const total = gpHLocal + gpAVisita;
  if (!total) return { probLocal: null, probEmpate: null, probVisita: null };

  const probLocal = Math.round(((local.wh || 0) + (visita.la || 0)) / total * 1000) / 10;
  const probEmpate = Math.round(((local.dh || 0) + (visita.da || 0)) / total * 1000) / 10;
  const probVisita = Math.round(((visita.wa || 0) + (local.lh || 0)) / total * 1000) / 10;
  return { probLocal, probEmpate, probVisita };
}

/**
 * La misma fórmula 1X2, pero con los datos GENERALES de cada equipo
 * (W/D/L/GP de la tabla de posiciones completa, sin separar casa/fuera).
 * Se muestra aparte, como comparación, sin reemplazar la de arriba.
 */
function calcular1X2General(local, visita) {
  if (!local || !visita) return { probLocal: null, probEmpate: null, probVisita: null };
  const total = (local.gp || 0) + (visita.gp || 0);
  if (!total) return { probLocal: null, probEmpate: null, probVisita: null };

  const probLocal = Math.round(((local.w || 0) + (visita.l || 0)) / total * 1000) / 10;
  const probEmpate = Math.round(((local.d || 0) + (visita.d || 0)) / total * 1000) / 10;
  const probVisita = Math.round(((visita.w || 0) + (local.l || 0)) / total * 1000) / 10;
  return { probLocal, probEmpate, probVisita };
}

// % de partidos ganados simple (sobre el total jugado por cada equipo, datos generales)
function pctGanadorSimple(equipo) {
  if (!equipo || !equipo.gp) return null;
  return Math.round(((equipo.w || 0) / equipo.gp) * 1000) / 10;
}

// % de partidos ganados jugando específicamente en casa (para el local) o fuera (para la visita)
function pctGanadorCasa(equipo) {
  if (!equipo) return null;
  const gpCasa = (equipo.wh || 0) + (equipo.dh || 0) + (equipo.lh || 0);
  if (!gpCasa) return null;
  return Math.round(((equipo.wh || 0) / gpCasa) * 1000) / 10;
}

function pctGanadorFuera(equipo) {
  if (!equipo) return null;
  const gpFuera = (equipo.wa || 0) + (equipo.da || 0) + (equipo.la || 0);
  if (!gpFuera) return null;
  return Math.round(((equipo.wa || 0) / gpFuera) * 1000) / 10;
}


function analizarPartido(partido, equipos, liga, slug) {
  const claveLocal = normalizar(partido.local);
  const claveVisita = normalizar(partido.visita);
  const local = equipos[claveLocal] || null;
  const visita = equipos[claveVisita] || null;

  const { probLocal, probEmpate, probVisita } = calcular1X2LV(local, visita);
  const general = calcular1X2General(local, visita);
  const favoritoEsLocal = (probLocal || 0) >= (probVisita || 0);
  const probFavorito = favoritoEsLocal ? probLocal : probVisita;
  const probDebil = favoritoEsLocal ? probVisita : probLocal;

  const overUnderYBtts = {
    over15: promedio(local?.over15, visita?.over15),
    over25: promedio(local?.over25, visita?.over25),
    over35: promedio(local?.over35, visita?.over35),
    btts: promedio(local?.btts, visita?.btts),
  };

  const primerTiempo = {
    over05HT: promedio(local?.over05HT, visita?.over05HT),
    over15HT: promedio(local?.over15HT, visita?.over15HT),
    over25HT: promedio(local?.over25HT, visita?.over25HT),
  };

  const rachaGanadoraLocal = local?.rachaTipo === 'W' && local?.rachaLongitud >= thresholds.minRachaGanadora;
  const rachaGanadoraVisita = visita?.rachaTipo === 'W' && visita?.rachaLongitud >= thresholds.minRachaGanadora;

  const cumple = {
    ganador60: probFavorito !== null && probFavorito >= thresholds.minGanadorFavorito && probDebil !== null && probDebil <= thresholds.maxGanadorDebil,
    ganadorSimple60: false, // se completa abajo
    over15_60: overUnderYBtts.over15 !== null && overUnderYBtts.over15 >= thresholds.minOver15,
    over25_60: overUnderYBtts.over25 !== null && overUnderYBtts.over25 >= thresholds.minOver25,
    btts60: overUnderYBtts.btts !== null && overUnderYBtts.btts >= thresholds.minBTTS,
    rachaGanadora: Boolean(rachaGanadoraLocal || rachaGanadoraVisita),
  };

  const winSimpleLocal = pctGanadorSimple(local);
  const winSimpleVisita = pctGanadorSimple(visita);
  cumple.ganadorSimple60 = (winSimpleLocal >= thresholds.minGanadorFavorito) || (winSimpleVisita >= thresholds.minGanadorFavorito);

  const destacado = cumple.ganador60 || cumple.over15_60 || cumple.over25_60 || cumple.btts60 || cumple.rachaGanadora;

  return {
    liga: liga.nombre,
    region: liga.region,
    ligaSlug: slug,
    equipoLocal: partido.local,
    equipoVisita: partido.visita,
    horaInicio: partido.fechaISO,
    equipoFavorito: favoritoEsLocal ? partido.local : partido.visita,
    probabilidades: {
      ganadorLocal: probLocal,
      empate: probEmpate,
      ganadorVisita: probVisita,
      generalLocal: general.probLocal,
      generalEmpate: general.probEmpate,
      generalVisita: general.probVisita,
      ganadorSimpleLocal: winSimpleLocal,
      ganadorSimpleVisita: winSimpleVisita,
      ganadorCasaLocal: pctGanadorCasa(local),
      ganadorFueraVisita: pctGanadorFuera(visita),
      btts: overUnderYBtts.btts,
      over15: overUnderYBtts.over15,
      over25: overUnderYBtts.over25,
      over35: overUnderYBtts.over35,
      over05HT: primerTiempo.over05HT,
      over15HT: primerTiempo.over15HT,
      over25HT: primerTiempo.over25HT,
    },
    rachas: {
      local: local ? `${local.rachaTipo || '-'}${local.rachaLongitud || ''}` : null,
      visita: visita ? `${visita.rachaTipo || '-'}${visita.rachaLongitud || ''}` : null,
    },
    ppg: {
      localGeneral: local?.ppg ?? calcularPPG(local?.w, local?.d, local?.l),
      localCasa: local?.ppgh ?? calcularPPG(local?.wh, local?.dh, local?.lh),
      visitaGeneral: visita?.ppg ?? calcularPPG(visita?.w, visita?.d, visita?.l),
      visitaFuera: visita?.ppga ?? calcularPPG(visita?.wa, visita?.da, visita?.la),
    },
    cumple,
    destacado,
  };
}

function main() {
  const soccerstats = leer('soccerstats.json');
  if (!soccerstats) {
    console.error('No existe public/data/soccerstats.json — corre primero fetch-soccerstats.js');
    process.exit(1);
  }

  const objetivo = fechaDeHoy();
  console.log(`Filtrando partidos del ${objetivo} (hora Ecuador)...`);

  const partidosAnalizados = [];
  for (const [slug, liga] of Object.entries(soccerstats.ligas)) {
    for (const partido of liga.partidos || []) {
      if (!partido.fechaISO || fechaEC(partido.fechaISO) !== objetivo) continue;
      partidosAnalizados.push(analizarPartido(partido, liga.equipos || {}, liga, slug));
    }
  }

  const resultado = {
    generadoEn: new Date().toISOString(),
    fechaObjetivo: objetivo,
    fuenteDatos: soccerstats.generadoEn,
    totalPartidos: partidosAnalizados.length,
    destacados: partidosAnalizados.filter((p) => p.destacado).length,
    partidos: partidosAnalizados,
  };

  const outPath = path.join(__dirname, '..', 'public', 'data', 'radar.json');
  fs.writeFileSync(outPath, JSON.stringify(resultado, null, 2));
  console.log(`Radar generado: ${resultado.destacados} destacados de ${resultado.totalPartidos} partidos para el ${objetivo}`);
}

main();
