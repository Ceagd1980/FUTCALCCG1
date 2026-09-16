const ZONA_HORARIA = 'America/Guayaquil'; // ajusta si quieres ver otra hora local

let datos = null;
let filtroActivo = 'destacados';

async function cargarDatos() {
  try {
    const res = await fetch(`data/radar.json?_=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    datos = await res.json();
    render();
  } catch (e) {
    document.getElementById('contenedorLigas').innerHTML =
      `<p class="vacio">No se pudo cargar data/radar.json todavía. Corre "npm run update" (o espera la primera ejecución diaria) y vuelve a intentar.</p>`;
    console.error(e);
  }
}

function formatearHora(iso) {
  const fecha = new Date(iso);
  const hora = fecha.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: ZONA_HORARIA });
  const dia = fecha.toLocaleDateString('es-EC', { day: '2-digit', month: 'short', timeZone: ZONA_HORARIA });
  return { hora, dia };
}

function pasaFiltro(partido) {
  const c = partido.cumple;
  switch (filtroActivo) {
    case 'destacados': return partido.destacado;
    case 'ganador60': return c.ganador60;
    case 'over15': return c.over15_60;
    case 'over25': return c.over25_60;
    case 'btts60': return c.btts60;
    case 'rachaGanadora': return c.rachaGanadora;
    case 'todos': return true;
    default: return true;
  }
}

function render() {
  document.getElementById('numDestacados').textContent = datos.destacados;
  const fechaHoy = new Date().toLocaleDateString('es-EC', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: ZONA_HORARIA,
  });
  document.getElementById('heroFecha').textContent = `Jornada del ${fechaHoy}, ${datos.totalPartidos} partidos analizados`;

  const gen = datos.generadoEn ? new Date(datos.generadoEn) : null;
  document.getElementById('ultimaActualizacion').textContent = gen
    ? `Datos actualizados: ${gen.toLocaleString('es-EC', { timeZone: ZONA_HORARIA })}`
    : '';

  const partidosFiltrados = datos.partidos.filter(pasaFiltro);
  const contenedor = document.getElementById('contenedorLigas');

  if (partidosFiltrados.length === 0) {
    contenedor.innerHTML = '<p class="vacio">Ningún partido cumple este filtro para mañana.</p>';
    return;
  }

  const porLiga = {};
  for (const p of partidosFiltrados) {
    if (!porLiga[p.liga]) porLiga[p.liga] = { region: p.region, partidos: [] };
    porLiga[p.liga].partidos.push(p);
  }
  for (const liga of Object.values(porLiga)) {
    liga.partidos.sort((a, b) => new Date(a.horaInicio) - new Date(b.horaInicio));
  }

  contenedor.innerHTML = Object.entries(porLiga)
    .map(([nombreLiga, grupo]) => renderGrupoLiga(nombreLiga, grupo))
    .join('');
}

function renderGrupoLiga(nombreLiga, grupo) {
  const filas = grupo.partidos.map(renderFilaPartido).join('');
  return `
    <section class="grupo-liga">
      <h2><span class="region">${grupo.region}</span> — ${nombreLiga}</h2>
      ${filas}
    </section>
  `;
}

function renderFilaPartido(p) {
  const { hora, dia } = formatearHora(p.horaInicio);
  const esLocalFavorito = p.equipoFavorito === p.equipoLocal;

  const detalles = [];
  if (p.rachas?.local || p.rachas?.visita) {
    detalles.push(`Racha: ${p.equipoLocal} ${p.rachas.local || '—'} / ${p.equipoVisita} ${p.rachas.visita || '—'}`);
  }

  const na = (v) => (v === null || v === undefined ? '—' : v);

  return `
    <article class="fila-partido ${p.destacado ? 'destacado' : ''}">
      <div class="hora">
        <span>${hora}</span>
        <span class="fecha-corta">${dia}</span>
      </div>
      <div class="equipos">
        <div class="equipo-linea ${esLocalFavorito ? 'favorito' : ''}">${p.equipoLocal}</div>
        <div class="equipo-linea ${!esLocalFavorito ? 'favorito' : ''}">${p.equipoVisita}</div>
        <div class="detalle-stats">
          ${detalles.map((d) => `<span>${d}</span>`).join('')}
        </div>
        <table class="cuadro-ppg">
          <thead>
            <tr><th>Métrica</th><th>General</th><th>L / V</th></tr>
          </thead>
          <tbody>
            <tr><td colspan="3" class="cuadro-subtitulo">1X2</td></tr>
            <tr>
              <td>Local</td>
              <td>${na(p.probabilidades.generalLocal)}%</td>
              <td>${na(p.probabilidades.ganadorLocal)}%</td>
            </tr>
            <tr>
              <td>Empate</td>
              <td>${na(p.probabilidades.generalEmpate)}%</td>
              <td>${na(p.probabilidades.empate)}%</td>
            </tr>
            <tr>
              <td>Visita</td>
              <td>${na(p.probabilidades.generalVisita)}%</td>
              <td>${na(p.probabilidades.ganadorVisita)}%</td>
            </tr>
            <tr><td colspan="3" class="cuadro-subtitulo">% Ganador propio</td></tr>
            <tr>
              <td>${p.equipoLocal}</td>
              <td>${na(p.probabilidades.ganadorSimpleLocal)}%</td>
              <td>${na(p.probabilidades.ganadorCasaLocal)}% (en casa)</td>
            </tr>
            <tr>
              <td>${p.equipoVisita}</td>
              <td>${na(p.probabilidades.ganadorSimpleVisita)}%</td>
              <td>${na(p.probabilidades.ganadorFueraVisita)}% (fuera)</td>
            </tr>
            <tr><td colspan="3" class="cuadro-subtitulo">PPG</td></tr>
            <tr>
              <td>${p.equipoLocal}</td>
              <td>${na(p.ppg?.localGeneral)}</td>
              <td>${na(p.ppg?.localCasa)} (en casa)</td>
            </tr>
            <tr>
              <td>${p.equipoVisita}</td>
              <td>${na(p.ppg?.visitaGeneral)}</td>
              <td>${na(p.ppg?.visitaFuera)} (fuera)</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="columna-probs">
        <div class="probabilidades">
          ${renderProb(p.probabilidades.btts, 'Ambos anotan', p.cumple.btts60)}
          ${renderProb(p.probabilidades.over15, 'Más 1.5', p.cumple.over15_60)}
          ${renderProb(p.probabilidades.over25, 'Más 2.5', p.cumple.over25_60)}
          ${renderProb(p.probabilidades.over35, 'Más 3.5', false)}
        </div>
        <div class="etiqueta-grupo-probs">Primer tiempo</div>
        <div class="probabilidades">
          ${renderProb(p.probabilidades.over05HT, 'Más 0.5 (1T)', false)}
          ${renderProb(p.probabilidades.over15HT, 'Más 1.5 (1T)', false)}
          ${renderProb(p.probabilidades.over25HT, 'Más 2.5 (1T)', false)}
        </div>
      </div>
    </article>
  `;
}

function renderProb(valor, etiqueta, cumple) {
  const texto = valor === null || valor === undefined ? '—' : `${valor}%`;
  return `
    <div class="prob">
      <div class="prob-valor ${cumple ? 'cumple' : ''}">${texto}</div>
      <div class="prob-etiqueta">${etiqueta}</div>
    </div>
  `;
}

document.getElementById('filtros').addEventListener('click', (e) => {
  const boton = e.target.closest('.filtro');
  if (!boton) return;
  document.querySelectorAll('.filtro').forEach((b) => b.classList.remove('activo'));
  boton.classList.add('activo');
  filtroActivo = boton.dataset.filtro;
  render();
});

cargarDatos();
