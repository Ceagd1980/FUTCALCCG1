# Radar de partidos — fútbol (v3, SoccerStats.com completo)

Web que cada día revisa los partidos de **mañana** en todas las ligas que
tengas activas en `config/leagues.js` y te muestra cuáles cumplen tus criterios,
usando **6 páginas distintas de SoccerStats.com**:

| Apartado | Página de SoccerStats | Umbral |
|---|---|---|
| Ganador 1X2 | `widetable.asp?league=X` | favorito ≥60%, débil ≤20% |
| Más de 1.5 / 2.5 goles, BTTS | `table.asp?league=X&tid=c` | ≥60% |
| Corners | `table.asp?league=X&tid=cr` | promedio ≥6 |
| Rachas ganadoras | `table.asp?league=X&tid=g` | ≥2 partidos ganados seguidos |
| Goleadores | `scorers.asp?league=X` | ≥0.75 goles/partido |
| Primer tiempo | `halftime.asp?league=X` | ver limitaciones abajo |

## Las fórmulas de 1X2 (exactamente como las pediste)

`widetable.asp` da, por equipo, el desglose de partidos ganados/empatados/
perdidos **en casa** (Wh, Dh, Lh) y **fuera** (Wa, Da, La). El 1X2 usa
específicamente los partidos del equipo local jugando **en casa** y del
equipo visita jugando **fuera**. Para un partido Local vs Visita:

```
Total = (Wh + Dh + Lh) del Local  +  (Wa + Da + La) del Visita

% Local  = (Wh_local + La_visita) / Total
% Empate = (Dh_local + Da_visita) / Total
% Visita = (Wa_visita + Lh_local) / Total
```

Esto está en `scripts/build-radar.js`, función `calcular1X2`. Los tres
porcentajes siempre suman 100% (es matemáticamente garantizado por la fórmula).

También se calcula el "% de ganador simple" que pediste (partidos ganados del
equipo / partidos jugados del equipo, sin split local/visita) — se ve en el
campo `ganadorSimpleLocal` / `ganadorSimpleVisita` de cada partido.

## ⚠️ Qué está verificado y qué es "mejor esfuerzo"

- **`widetable.asp`** y **`table.asp?tid=c`** (Over/Under+BTTS): verifiqué su
  estructura real contra varias ligas antes de escribir el código. Deberían
  funcionar de forma confiable.
- **`table.asp?tid=cr` (corners), `table.asp?tid=g` (rachas), `scorers.asp`
  (goleadores) y `halftime.asp` (primer tiempo)**: no pude confirmar su
  estructura exacta de columnas desde mi entorno (sin acceso a internet hacia
  soccerstats.com). El código las scrapea con una lógica flexible basada en
  palabras clave del encabezado, pero **es lo primero que hay que revisar**
  si ves esos campos vacíos. Ver la sección de depuración abajo.

## ⚠️ Sobre "primer tiempo, ambos marcan"

No tuve forma de confirmar si `halftime.asp` publica un % directo de "ambos
equipos marcaron en el primer tiempo" o solo resultados/goles al descanso.
El scraper guarda lo que encuentra como `htGolesFavorAprox` /
`htGolesContraAprox`, pero **no arma todavía un % de "ambos marcan en el
HT"** — es la pieza más incierta de esta versión. Si al correr `npm run
fetch:stats` ves que esos números no tienen sentido, avísame con lo que
encuentres en el HTML real de esa página y lo ajusto.

## Instalación y primera prueba (haz esto ANTES de automatizar nada)

```bash
npm install
npm run update      # corre fetch-soccerstats + build-radar
npx serve public     # abre el link que te da, para ver la web
```

Revisa la consola de `npm run update` línea por línea. Para cada liga verás
algo como:

```
Procesando England - Premier League (england)...
  -> 20 equipos, 8 partidos, 45 goleadores
```

Si ves "0 equipos" para una liga, empieza por revisar `widetable.asp` de esa
liga en el navegador. Si ves "0 goleadores" o corners/rachas vacíos, son las
páginas de "mejor esfuerzo" — abre esa URL, clic derecho → "Ver código
fuente", y compara contra las funciones `parsearCorners`, `parsearRachas`,
`parsearGoleadores` o `parsearPrimerTiempo` en `scripts/fetch-soccerstats.js`
(cada una tiene comentarios explicando qué columna se espera en qué posición).

**Recomendación fuerte:** empieza con 5-10 ligas activas en `config/leagues.js`
(comenta las demás con `//`) hasta confirmar que el parseo funciona bien.

## Pasos para subir la web (GitHub + Netlify, sin API keys)

Todo el proceso es scraping público — no necesitas ninguna cuenta de pago ni
clave secreta.

### 1. Sube el proyecto a GitHub
Si ya tienes el repo de una versión anterior, simplemente reemplaza todos los
archivos por los de este zip y vuelve a subir (mismo repo). Si es la primera vez:

1. Ve a **github.com** → **+** → **New repository** → nómbralo (ej. `futbol-radar`) → **Create repository**.
2. En la página del repo, usa **"uploading an existing file"**.
3. Abre la carpeta `futbol-radar` descomprimida en tu computadora, selecciona
   **todo su contenido** (no la carpeta en sí) y arrástralo a GitHub.
4. Baja y dale **Commit changes**.

### 2. Activa la actualización diaria
El archivo `.github/workflows/daily-radar.yml` ya está listo, sin necesidad
de configurar ningún secreto. Corre todos los días a las 09:00 UTC (04:00 en
Ecuador). Para probarlo sin esperar: pestaña **Actions** de tu repo →
"Actualizar radar diario" → **Run workflow**.

### 3. Conecta el repo a Netlify
1. En **netlify.com**: **Add new site → Import an existing project → GitHub** → tu repo.
2. Publish directory: `public`.
3. **Deploy site**.

Cada vez que el robot diario actualice los datos en GitHub, Netlify vuelve a
publicar la web sola — no tienes que hacer nada manualmente día a día.

## ⚠️ SoccerStats bloquea peticiones simples — este proyecto usa un navegador real

SoccerStats.com detecta y bloquea (error 403) las peticiones HTTP normales
(fetch/curl), incluso con encabezados de navegador. Por eso `fetch-soccerstats.js`
usa **Puppeteer**, que controla una ventana de Chrome real e invisible en vez
de pedir la página directamente. Consecuencias prácticas:

- La primera vez que corras `npm install`, va a descargar Chromium
  (~200 MB) — es normal, solo pasa una vez.
- Cada página tarda unos segundos en cargar (en vez de ser instantánea),
  así que el proceso completo es más lento.
- **No hay garantía al 100%**: si SoccerStats endurece su protección más
  adelante (ej. un captcha visual), ni un navegador automatizado la pasaría
  sin intervención humana.

## Sobre la cantidad de peticiones

Cada liga activa hace **7 peticiones** a SoccerStats por corrida, cada una a
través de un navegador real (más lento que una petición HTTP directa). Con
las ~150 ligas de `config/leagues.js` activas, una corrida completa puede
tardar bien más de una hora. Para ser respetuoso con el sitio:

- Empieza con pocas ligas activas y ve ampliando gradualmente.
- Si activas muchas, considera correr la actualización cada 2 días en vez de
  a diario (cambia el `cron` en `.github/workflows/daily-radar.yml`).

## Estructura del proyecto

```
config/
  leagues.js        # todas las ligas de SoccerStats (comenta las que no uses)
  thresholds.js      # tus umbrales: 60%/20% para 1X2, 60% para goles, 6 corners, etc.
scripts/
  fetch-soccerstats.js  # scraping de las 6 páginas -> public/data/soccerstats.json
  build-radar.js        # fórmula 1X2 + filtra "mañana" + aplica umbrales -> public/data/radar.json
public/
  index.html, css/, js/   # el sitio que ves en el navegador
.github/workflows/
  daily-radar.yml     # automatización diaria (no requiere secretos)
```

## Aviso

Herramienta de apoyo estadístico, no garantía de resultado. El % de 1X2 sale
de una fórmula matemática sobre resultados históricos, no de una casa de
apuestas — puede diferir bastante de las cuotas reales de mercado, sobre todo
en ligas con pocos partidos jugados en la temporada. Los apartados de
corners, rachas, goleadores y primer tiempo son parseo de mejor esfuerzo y
necesitan tu validación con datos reales antes de confiar en ellos.
