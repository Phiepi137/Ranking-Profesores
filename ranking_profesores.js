(() => {
  const API_BASE = 'https://wssaac.espol.edu.ec/heteroevaluacion-reportes/api/reportes';

  const CRITERIOS = [
    { key: 'planificacion', label: 'Planificación', short: 'Planif.', color: '#0f9f8f' },
    { key: 'aprendizaje', label: 'Aprendizaje', short: 'Aprendiz.', color: '#2563eb' },
    { key: 'retroalimentacion', label: 'Retroalimentación', short: 'Retro.', color: '#7c3aed' },
    { key: 'comportamiento', label: 'Comportamiento', short: 'Comport.', color: '#d97706' },
    { key: 'satisfaccion', label: 'Satisfacción', short: 'Satisf.', color: '#e11d48' }
  ];

  const state = {
    materia: '',
    ranking: [],
    detalleParaleloCache: new Map(),
    detailSeries: null,
    compareSeries: null,
    compareProfiles: null
  };

  const ui = {
    searchForm: document.getElementById('searchForm'),
    materia: document.getElementById('materia'),
    buscar: document.getElementById('buscar'),
    status: document.getElementById('status'),
    stats: document.getElementById('stats'),
    rankingMeta: document.getElementById('rankingMeta'),
    resultados: document.getElementById('resultados'),
    detalles: document.getElementById('detalles'),
    profesorA: document.getElementById('profesorA'),
    profesorB: document.getElementById('profesorB'),
    comparar: document.getElementById('comparar'),
    comparacion: document.getElementById('comparacion')
  };

  function normalizarTexto(texto) {
    if (!texto) return '';
    return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  }

  function normalizarBusqueda(texto) {
    if (!texto) return '';
    return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function extraerLista(payload) {
    if (Array.isArray(payload)) return payload;
    return payload?.datos || payload?.data || payload?.items || payload?.value || [];
  }

  function numeroSeguro(valor) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
  }

  function promedioSeguro(valores) {
    return valores.length ? valores.reduce((total, valor) => total + valor, 0) / valores.length : 0;
  }

  function promedioONull(valores) {
    return valores.length ? promedioSeguro(valores) : null;
  }

  function format(valor, decimales = 2) {
    return Number.isFinite(valor) ? valor.toFixed(decimales) : '-';
  }

  function clamp(valor, min = 0, max = 100) {
    return Math.max(min, Math.min(max, valor));
  }

  function hexToRgba(hex, alpha) {
    const limpio = hex.replace('#', '');
    const entero = parseInt(limpio, 16);
    const r = (entero >> 16) & 255;
    const g = (entero >> 8) & 255;
    const b = entero & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function setStatus(mensaje, tipo = 'info') {
    ui.status.textContent = mensaje;
    ui.status.classList.toggle('is-error', tipo === 'error');
  }

  function setLoading(estaCargando) {
    ui.buscar.disabled = estaCargando;
    ui.buscar.textContent = estaCargando ? 'Analizando...' : 'Analizar';
  }

  async function fetchJson(url, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const respuesta = await fetch(url, { signal: controller.signal });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      return respuesta.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolverEnLotes(items, worker, batchSize = 8) {
    const resultados = [];

    for (let index = 0; index < items.length; index += batchSize) {
      const lote = items.slice(index, index + batchSize);
      resultados.push(...await Promise.all(lote.map(worker)));
    }

    return resultados;
  }

  function obtenerNombreProfesor(registro) {
    return normalizarTexto(`${registro.apellidos || ''} ${registro.nombres || ''}`);
  }

  async function obtenerParalelosMateria(materia) {
    const pageSize = 200;
    const primeraUrl = `${API_BASE}/paralelos-materia/${encodeURIComponent(materia)}/1/${pageSize}`;
    const primerPayload = await fetchJson(primeraUrl);
    const total = Number(primerPayload?.total) || 0;
    const registros = extraerLista(primerPayload);
    const totalPaginas = total ? Math.ceil(total / pageSize) : 1;

    if (totalPaginas <= 1) return registros;

    const paginas = Array.from({ length: totalPaginas - 1 }, (_, index) => index + 2);
    const respuestas = await Promise.all(paginas.map(async (pagina) => {
      const url = `${API_BASE}/paralelos-materia/${encodeURIComponent(materia)}/${pagina}/${pageSize}`;
      try {
        return extraerLista(await fetchJson(url));
      } catch (_) {
        return [];
      }
    }));

    return registros.concat(...respuestas);
  }

  function construirRanking(registros, materiaIngresada) {
    const profesores = new Map();

    for (const registro of registros) {
      const profesor = obtenerNombreProfesor(registro);
      const nota = numeroSeguro(registro.promedio ?? registro.calificacion ?? registro.nota);
      const cedula = registro.cedula || registro.identificacion || registro.idpersona || profesor;
      const key = `${cedula}-${profesor}`;

      if (!profesor || nota === null) continue;

      if (!profesores.has(key)) {
        profesores.set(key, {
          profesor,
          cedula,
          materia: registro.materia || materiaIngresada,
          notas: [],
          registros: [],
          perfil: null
        });
      }

      const item = profesores.get(key);
      item.notas.push(nota);
      item.registros.push(registro);
    }

    return Array.from(profesores.values()).map((item) => {
      const n = item.notas.length;
      const promedio = promedioSeguro(item.notas);
      const variance = item.notas.reduce((acc, x) => acc + ((x - promedio) ** 2), 0) / n;
      const desv = Math.sqrt(variance);
      const minNota = Math.min(...item.notas);
      const maxNota = Math.max(...item.notas);
      const rango = maxNota - minNota;
      return { ...item, promedio, desv, minNota, maxNota, rango, n };
    }).sort((a, b) => (
      (b.promedio - a.promedio) ||
      (b.n - a.n) ||
      (a.desv - b.desv)
    ));
  }

  function clasificarArea(areaRaw, preguntaRaw = '') {
    const area = normalizarBusqueda(areaRaw);
    const pregunta = normalizarBusqueda(preguntaRaw);
    const texto = `${area} ${pregunta}`;

    if (texto.includes('satisfaccion') || texto.includes('satisfecho')) return 'satisfaccion';
    if (
      texto.includes('gestion del aula') ||
      texto.includes('comportamiento') ||
      texto.includes('tecnologia') ||
      texto.includes('cordial') ||
      texto.includes('respetuoso') ||
      texto.includes('puntual') ||
      texto.includes('asiste')
    ) return 'comportamiento';
    if (
      texto.includes('evaluacion') ||
      texto.includes('retroalimentacion') ||
      texto.includes('calificar') ||
      texto.includes('calificaciones') ||
      texto.includes('rubrica') ||
      texto.includes('criterios')
    ) return 'retroalimentacion';
    if (
      texto.includes('planificacion') ||
      texto.includes('silabo') ||
      texto.includes('politicas') ||
      texto.includes('objetivos') ||
      texto.includes('contenido') ||
      texto.includes('planificado') ||
      texto.includes('tiempo en clase') ||
      texto.includes('relacion entre los resultados')
    ) return 'planificacion';
    if (
      texto.includes('ensenanza') ||
      texto.includes('aprendizaje') ||
      texto.includes('actividades') ||
      texto.includes('autonomo') ||
      texto.includes('colaborativo') ||
      texto.includes('interes') ||
      texto.includes('estrategias') ||
      texto.includes('ejemplos') ||
      texto.includes('materiales') ||
      texto.includes('instrucciones')
    ) return 'aprendizaje';

    return null;
  }

  function escalarValorPregunta(pregunta) {
    const media = numeroSeguro(pregunta.media);
    if (media !== null) {
      if (media <= 5) return clamp(media * 20);
      if (media <= 10) return clamp(media * 10);
      return clamp(media);
    }

    const promedio = numeroSeguro(pregunta.promedio);
    if (promedio !== null) {
      if (promedio <= 7) return clamp((promedio / 7) * 100);
      if (promedio <= 10) return clamp(promedio * 10);
      return clamp(promedio);
    }

    const porcentaje = numeroSeguro(pregunta.porcentaje);
    if (porcentaje !== null) return clamp(porcentaje <= 1 ? porcentaje * 100 : porcentaje);

    return null;
  }

  async function obtenerDetalleParalelo(registro) {
    const anio = registro.anio;
    const termino = registro.termino;
    const codigo = registro.codigo || registro.codigoMateria;
    const paralelo = registro.paralelo;
    const cedula = registro.cedula || registro.identificacion || registro.idpersona;

    if (!anio || !termino || !codigo || !paralelo || !cedula) return [];

    const key = [anio, termino, codigo, paralelo, cedula].join('|');
    if (!state.detalleParaleloCache.has(key)) {
      const url = `${API_BASE}/paralelo-detalle/${encodeURIComponent(anio)}/${encodeURIComponent(termino)}/${encodeURIComponent(codigo)}/${encodeURIComponent(paralelo)}/${encodeURIComponent(cedula)}`;
      const request = fetchJson(url, 9000).then(extraerLista).catch(() => []);
      state.detalleParaleloCache.set(key, request);
    }

    return state.detalleParaleloCache.get(key);
  }

  async function obtenerPerfilProfesor(rankingIndex) {
    const profesor = state.ranking[rankingIndex];
    if (!profesor) throw new Error('Profesor no disponible en el ranking actual.');
    if (profesor.perfil) return profesor.perfil;

    const areas = Object.fromEntries(CRITERIOS.map((criterio) => [criterio.key, []]));
    const notasValidas = profesor.registros
      .map((registro) => numeroSeguro(registro.promedio ?? registro.calificacion ?? registro.nota))
      .filter((nota) => nota !== null);

    const detalles = await resolverEnLotes(profesor.registros, obtenerDetalleParalelo);
    for (const preguntas of detalles) {
      for (const pregunta of preguntas) {
        const criterio = clasificarArea(pregunta.area || '', pregunta.pregunta || '');
        const valor = escalarValorPregunta(pregunta);
        if (criterio && valor !== null) areas[criterio].push(valor);
      }
    }

    const criterios = CRITERIOS.map((criterio) => ({
      ...criterio,
      valor: promedioONull(areas[criterio.key]),
      muestras: areas[criterio.key].length
    }));

    profesor.perfil = {
      profesor: profesor.profesor,
      materia: profesor.materia,
      desv: profesor.desv,
      minNota: profesor.minNota,
      maxNota: profesor.maxNota,
      rango: profesor.rango,
      promedioGeneral: promedioSeguro(notasValidas),
      paralelos: profesor.registros.length,
      preguntasUsadas: criterios.reduce((total, criterio) => total + criterio.muestras, 0),
      criterios
    };

    return profesor.perfil;
  }

  function prepararCanvas(canvas) {
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(bounds.width || 620));
    const height = Math.round(width * 0.86);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function dibujarEtiqueta(ctx, texto, x, y, align = 'center') {
    ctx.fillStyle = '#314158';
    ctx.font = '700 12px Arial';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(texto, x, y);
  }

  function obtenerValoresFinitos(series) {
    return series.flatMap((serie) => serie.values).filter((valor) => Number.isFinite(valor));
  }

  function crearEscalaRadar(series, enfoque = false) {
    if (!enfoque) {
      return { min: 0, max: 100, focused: false };
    }

    const valores = obtenerValoresFinitos(series);
    if (!valores.length) {
      return { min: 0, max: 100, focused: false };
    }

    const minValor = Math.min(...valores);
    const maxValor = Math.max(...valores);
    const spread = maxValor - minValor;
    const padding = spread === 0 ? 1 : Math.max(0.65, spread * 0.28);
    const min = Math.max(0, minValor - padding);
    const max = Math.min(100, maxValor + padding);

    if (max - min < 1.5) {
      const centro = (minValor + maxValor) / 2;
      return {
        min: Math.max(0, centro - 0.75),
        max: Math.min(100, centro + 0.75),
        focused: true
      };
    }

    return { min, max, focused: true };
  }

  function escalarRadar(valor, escala) {
    if (!Number.isFinite(valor)) return 0;
    const rango = escala.max - escala.min || 1;
    return clamp(((valor - escala.min) / rango) * 100);
  }

  function puntosRadar(values, cx, cy, radius, total, escala) {
    return values.map((valor, index) => {
      const angle = (-Math.PI / 2) + (index * 2 * Math.PI / total);
      const r = radius * escalarRadar(valor, escala) / 100;
      return {
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        angle
      };
    });
  }

  function trazarPoligono(ctx, puntos) {
    ctx.beginPath();
    puntos.forEach((punto, index) => {
      if (index === 0) ctx.moveTo(punto.x, punto.y);
      else ctx.lineTo(punto.x, punto.y);
    });
    ctx.closePath();
  }

  function dibujarRadar(canvas, series, options = {}) {
    const { ctx, width, height } = prepararCanvas(canvas);
    const total = CRITERIOS.length;
    const cx = width / 2;
    const cy = height / 2 + (options.focused ? 18 : 8);
    const radius = Math.min(width, height) * (options.focused ? 0.36 : 0.32);
    const levels = 5;
    const escala = crearEscalaRadar(series, Boolean(options.focused));

    ctx.clearRect(0, 0, width, height);

    const radial = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * 1.25);
    radial.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    radial.addColorStop(1, 'rgba(231, 240, 255, 0.72)');
    ctx.fillStyle = radial;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.16, 0, Math.PI * 2);
    ctx.fill();

    for (let level = levels; level >= 1; level--) {
      const r = (radius * level) / levels;
      const puntos = CRITERIOS.map((_, index) => {
        const angle = (-Math.PI / 2) + (index * 2 * Math.PI / total);
        return {
          x: cx + r * Math.cos(angle),
          y: cy + r * Math.sin(angle)
        };
      });

      trazarPoligono(ctx, puntos);
      ctx.fillStyle = level % 2 === 0 ? 'rgba(37, 99, 235, 0.035)' : 'rgba(15, 159, 143, 0.035)';
      ctx.fill();
      ctx.strokeStyle = level === levels ? 'rgba(37, 99, 235, 0.24)' : 'rgba(103, 116, 139, 0.22)';
      ctx.lineWidth = level === levels ? 1.4 : 1;
      ctx.stroke();
    }

    CRITERIOS.forEach((criterio, index) => {
      const angle = (-Math.PI / 2) + (index * 2 * Math.PI / total);
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(103, 116, 139, 0.20)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const tx = cx + (radius + 42) * Math.cos(angle);
      const ty = cy + (radius + 28) * Math.sin(angle);
      const align = tx < cx - 8 ? 'right' : (tx > cx + 8 ? 'left' : 'center');
      dibujarEtiqueta(ctx, criterio.short, tx, ty, align);
    });

    ctx.fillStyle = '#738196';
    ctx.font = '700 10px Arial';
    ctx.textAlign = 'center';
    for (let level = 1; level <= levels; level++) {
      const r = (radius * level) / levels;
      const valorEtiqueta = escala.min + ((escala.max - escala.min) * level / levels);
      ctx.fillText(format(valorEtiqueta, escala.focused ? 1 : 0), cx + 22, cy - r + 4);
    }

    series.forEach((serie, serieIndex) => {
      const values = serie.values.map((value) => Number.isFinite(value) ? clamp(value) : null);
      const puntos = puntosRadar(values, cx, cy, radius, total, escala);

      trazarPoligono(ctx, puntos);
      ctx.fillStyle = hexToRgba(serie.color, serieIndex === 0 ? 0.22 : 0.16);
      ctx.fill();

      trazarPoligono(ctx, puntos);
      ctx.strokeStyle = serie.color;
      ctx.lineWidth = 3;
      ctx.shadowColor = hexToRgba(serie.color, 0.35);
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      puntos.forEach((punto) => {
        ctx.beginPath();
        ctx.arc(punto.x, punto.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = serie.color;
        ctx.stroke();
      });
    });

    if (escala.focused) {
      ctx.fillStyle = '#152033';
      ctx.font = '800 13px Arial';
      ctx.textAlign = 'left';
      ctx.fillText(`Escala ampliada: ${format(escala.min, 1)} - ${format(escala.max, 1)}`, 22, 28);
      ctx.fillStyle = '#66758a';
      ctx.font = '700 11px Arial';
      ctx.fillText('Modo lupa para comparar diferencias pequeñas', 22, 47);
    }
  }

  function renderLegend(series) {
    return `
      <div class="legend">
        ${series.map((serie) => `
          <span class="legend-item">
            <span class="legend-swatch" style="background:${serie.color}"></span>
            ${escapeHtml(serie.label)}
          </span>
        `).join('')}
      </div>
    `;
  }

  function renderMetricas(perfil) {
    return `
      <div class="metrics-list">
        ${perfil.criterios.map((criterio) => `
          <div class="metric-row">
            <div class="metric-line">
              <strong>${escapeHtml(criterio.label)}</strong>
              <span>${criterio.muestras ? `${format(criterio.valor)} / 100` : 'Sin datos'}</span>
            </div>
            <div class="meter" aria-hidden="true">
              <div class="meter-fill" style="width:${clamp(criterio.valor ?? 0)}%; background:linear-gradient(90deg, ${criterio.color}, #2563eb)"></div>
            </div>
            <span class="muted">${criterio.muestras ? `${criterio.muestras} preguntas evaluadas` : 'Sin preguntas disponibles'}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderStats(registros, ranking) {
    const paralelos = registros.length;
    const profesores = ranking.length;
    const mejor = ranking[0];
    const promedioGlobal = promedioSeguro(registros.map((r) => numeroSeguro(r.promedio)).filter((n) => n !== null));

    ui.stats.hidden = false;
    ui.stats.innerHTML = `
      <div class="stat"><span>Registros</span><strong>${paralelos}</strong></div>
      <div class="stat"><span>Profesores</span><strong>${profesores}</strong></div>
      <div class="stat"><span>Promedio</span><strong>${format(promedioGlobal)}</strong></div>
      <div class="stat"><span>Mayor promedio</span><strong>${mejor ? format(mejor.promedio) : '-'}</strong></div>
    `;
  }

  function renderResultados() {
    if (!state.ranking.length) {
      ui.resultados.innerHTML = '<div class="empty-state">No hay datos disponibles para esa materia.</div>';
      ui.rankingMeta.textContent = '';
      return;
    }

    ui.rankingMeta.textContent = `${state.ranking.length} profesores`;

    const rows = state.ranking.map((item, index) => `
      <tr>
        <td class="rank-cell">#${index + 1}</td>
        <td class="teacher-cell">
          <strong>${escapeHtml(item.profesor)}</strong>
          <span>${escapeHtml(item.materia)}</span>
        </td>
        <td><span class="metric-pill">${format(item.promedio)}</span></td>
        <td>${format(item.desv)}</td>
        <td>${item.n}</td>
        <td>${format(item.minNota)} - ${format(item.maxNota)}</td>
        <td>${format(item.rango)}</td>
        <td><button class="btn-small" type="button" data-action="details" data-index="${index}">Ver detalle</button></td>
      </tr>
    `).join('');

    const top = state.ranking.slice(0, 3).map((item, index) => `
      <li>
        <span class="medal">${index + 1}</span>
        <span>${escapeHtml(item.profesor)}</span>
        <strong>${format(item.promedio)}</strong>
      </li>
    `).join('');

    ui.resultados.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Profesor</th>
              <th>Prom.</th>
              <th>Desv.</th>
              <th>n</th>
              <th>Min - Max</th>
              <th>Rango</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <ol class="top-list">${top}</ol>
    `;
  }

  function renderCompareControls() {
    const options = [
      '<option value="">Selecciona un profesor</option>',
      ...state.ranking.map((item, index) => `<option value="${index}">${escapeHtml(item.profesor)}</option>`)
    ].join('');

    ui.profesorA.innerHTML = options;
    ui.profesorB.innerHTML = options;
    ui.profesorA.disabled = state.ranking.length < 2;
    ui.profesorB.disabled = state.ranking.length < 2;
    ui.comparar.disabled = state.ranking.length < 2;

    if (state.ranking.length >= 2) {
      ui.profesorA.value = '0';
      ui.profesorB.value = '1';
      ui.comparacion.className = 'compare-empty';
      ui.comparacion.textContent = 'Selecciona dos profesores y presiona Comparar.';
    } else {
      ui.comparacion.className = 'compare-empty';
      ui.comparacion.textContent = 'Se necesitan al menos dos profesores.';
    }
  }

  async function mostrarDetallesProfesor(rankingIndex) {
    const profesor = state.ranking[rankingIndex];
    if (!profesor) return;

    ui.detalles.innerHTML = '<section class="details-panel">Cargando perfil del profesor...</section>';

    try {
      const perfil = await obtenerPerfilProfesor(rankingIndex);
      const serie = [{
        label: perfil.profesor,
        color: '#0f9f8f',
        values: perfil.criterios.map((criterio) => criterio.valor)
      }];
      state.detailSeries = serie;

      ui.detalles.innerHTML = `
        <section class="details-panel">
          <div class="details-heading">
            <div>
              <p class="eyebrow">Perfil por criterios</p>
              <h2>${escapeHtml(perfil.profesor)}</h2>
              <div class="badge-row">
                <span class="badge">${escapeHtml(perfil.materia)}</span>
                <span class="badge">Promedio ${format(perfil.promedioGeneral)}</span>
                <span class="badge">Desv. ${format(perfil.desv)}</span>
                <span class="badge">Rango ${format(perfil.minNota)} - ${format(perfil.maxNota)}</span>
                <span class="badge">${perfil.paralelos} paralelos</span>
                <span class="badge">${perfil.preguntasUsadas} preguntas</span>
              </div>
            </div>
          </div>

          <div class="details-grid">
            <div>
              <div class="chart-wrap">
                <canvas id="detailRadar" width="640" height="540"></canvas>
              </div>
              ${renderLegend(serie)}
            </div>
            ${renderMetricas(perfil)}
          </div>
        </section>
      `;

      dibujarRadar(document.getElementById('detailRadar'), serie);
      ui.detalles.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      ui.detalles.innerHTML = `<section class="details-panel">Error al cargar detalles: ${escapeHtml(error.message)}</section>`;
    }
  }

  function renderDiferencias(perfilA, perfilB) {
    return `
      <div class="diff-list">
        ${CRITERIOS.map((criterio, index) => {
          const valorA = perfilA.criterios[index].valor;
          const valorB = perfilB.criterios[index].valor;
          const hayComparacion = Number.isFinite(valorA) && Number.isFinite(valorB);
          const delta = hayComparacion ? valorA - valorB : null;
          const ganador = !hayComparacion
            ? 'Sin datos comparables'
            : (Math.abs(delta) < 0.25 ? 'Empate' : (delta > 0 ? perfilA.profesor : perfilB.profesor));

          return `
            <div class="diff-row">
              <div class="diff-line">
                <strong>${escapeHtml(criterio.label)}</strong>
                <span class="diff-value">${hayComparacion ? `${delta >= 0 ? '+' : ''}${format(delta)}` : '-'}</span>
              </div>
              <span class="muted">${escapeHtml(ganador)} | ${format(valorA)} vs ${format(valorB)}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  async function compararProfesores() {
    const valorA = ui.profesorA.value;
    const valorB = ui.profesorB.value;
    const indexA = Number(valorA);
    const indexB = Number(valorB);

    if (valorA === '' || valorB === '' || !Number.isInteger(indexA) || !Number.isInteger(indexB)) {
      ui.comparacion.className = 'compare-empty';
      ui.comparacion.textContent = 'Selecciona dos profesores.';
      return;
    }

    if (indexA === indexB) {
      ui.comparacion.className = 'compare-empty';
      ui.comparacion.textContent = 'Selecciona dos profesores distintos.';
      return;
    }

    ui.comparar.disabled = true;
    ui.comparacion.className = 'compare-empty';
    ui.comparacion.textContent = 'Cargando perfiles para comparación...';

    try {
      const [perfilA, perfilB] = await Promise.all([
        obtenerPerfilProfesor(indexA),
        obtenerPerfilProfesor(indexB)
      ]);

      const series = [
        {
          label: perfilA.profesor,
          color: '#0f9f8f',
          values: perfilA.criterios.map((criterio) => criterio.valor)
        },
        {
          label: perfilB.profesor,
          color: '#e11d48',
          values: perfilB.criterios.map((criterio) => criterio.valor)
        }
      ];
      state.compareSeries = series;
      state.compareProfiles = [perfilA, perfilB];

      ui.comparacion.className = 'compare-result';
      ui.comparacion.innerHTML = `
        <div class="comparison-grid">
          <div>
            <div class="compare-actions">
              <button class="btn-small btn-secondary" type="button" data-action="open-fullscreen-compare">Pantalla completa</button>
            </div>
            <div class="chart-wrap">
              <canvas id="compareRadar" width="640" height="540"></canvas>
            </div>
            ${renderLegend(series)}
          </div>
          ${renderDiferencias(perfilA, perfilB)}
        </div>
      `;

      dibujarRadar(document.getElementById('compareRadar'), series);
    } catch (error) {
      ui.comparacion.className = 'compare-empty';
      ui.comparacion.textContent = `Error al comparar: ${error.message}`;
    } finally {
      ui.comparar.disabled = state.ranking.length < 2;
    }
  }

  function asegurarModalComparacion() {
    let modal = document.getElementById('compareFullscreen');
    if (modal) return modal;

    modal = document.createElement('section');
    modal.id = 'compareFullscreen';
    modal.className = 'fullscreen-modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="fullscreen-backdrop" data-action="close-fullscreen-compare"></div>
      <div class="fullscreen-panel" role="dialog" aria-modal="true" aria-labelledby="fullscreenTitle">
        <div class="fullscreen-header">
          <div>
            <p class="eyebrow">Comparación ampliada</p>
            <h2 id="fullscreenTitle">Radar superpuesto</h2>
            <p id="fullscreenSubtitle" class="muted"></p>
          </div>
          <button class="btn-small btn-secondary" type="button" data-action="close-fullscreen-compare">Cerrar</button>
        </div>
        <div class="fullscreen-body">
          <div class="fullscreen-chart">
            <canvas id="compareRadarFullscreen" width="1080" height="860"></canvas>
          </div>
          <div id="fullscreenDiffs" class="fullscreen-diffs"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    return modal;
  }

  function abrirComparacionPantallaCompleta() {
    if (!state.compareSeries || !state.compareProfiles) return;

    const modal = asegurarModalComparacion();
    const [perfilA, perfilB] = state.compareProfiles;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    document.getElementById('fullscreenSubtitle').textContent = `${perfilA.profesor} vs ${perfilB.profesor}`;
    document.getElementById('fullscreenDiffs').innerHTML = renderDiferencias(perfilA, perfilB);
    dibujarRadar(document.getElementById('compareRadarFullscreen'), state.compareSeries, { focused: true });
  }

  function cerrarComparacionPantallaCompleta() {
    const modal = document.getElementById('compareFullscreen');
    if (!modal) return;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }

  async function analizarMateria(event) {
    event.preventDefault();

    const materia = ui.materia.value.trim().toUpperCase();
    if (!materia) {
      setStatus('Ingresa un código de materia.', 'error');
      return;
    }

    state.materia = materia;
    state.ranking = [];
    state.detalleParaleloCache.clear();
    state.detailSeries = null;
    state.compareSeries = null;
    state.compareProfiles = null;
    ui.detalles.innerHTML = '';
    ui.stats.hidden = true;
    ui.rankingMeta.textContent = '';
    ui.resultados.innerHTML = '<div class="empty-state">Consultando registros...</div>';
    ui.comparacion.className = 'compare-empty';
    ui.comparacion.textContent = 'La comparación aparecerá aquí.';
    ui.profesorA.disabled = true;
    ui.profesorB.disabled = true;
    ui.comparar.disabled = true;

    setLoading(true);
    setStatus(`Analizando ${materia}...`);

    try {
      const registros = await obtenerParalelosMateria(materia);
      if (!registros.length) {
        setStatus('No hay datos disponibles para esa materia.', 'error');
        renderResultados();
        return;
      }

      state.ranking = construirRanking(registros, materia);
      renderStats(registros, state.ranking);
      renderResultados();
      renderCompareControls();
      setStatus(`${state.ranking.length} profesores analizados para ${materia}.`);
    } catch (error) {
      setStatus(`Error al consultar datos: ${error.message}`, 'error');
      ui.resultados.innerHTML = '<div class="empty-state">No se pudo cargar el ranking.</div>';
    } finally {
      setLoading(false);
    }
  }

  ui.searchForm.addEventListener('submit', analizarMateria);
  ui.comparar.addEventListener('click', compararProfesores);
  ui.resultados.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="details"]');
    if (!button) return;
    mostrarDetallesProfesor(Number(button.dataset.index));
  });
  ui.comparacion.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="open-fullscreen-compare"]');
    if (!button) return;
    abrirComparacionPantallaCompleta();
  });
  document.addEventListener('click', (event) => {
    const closeTarget = event.target.closest('[data-action="close-fullscreen-compare"]');
    if (closeTarget) cerrarComparacionPantallaCompleta();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cerrarComparacionPantallaCompleta();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const detailCanvas = document.getElementById('detailRadar');
      const compareCanvas = document.getElementById('compareRadar');
      const fullscreenCanvas = document.getElementById('compareRadarFullscreen');
      if (detailCanvas && state.detailSeries) dibujarRadar(detailCanvas, state.detailSeries);
      if (compareCanvas && state.compareSeries) dibujarRadar(compareCanvas, state.compareSeries);
      if (fullscreenCanvas && state.compareSeries && document.getElementById('compareFullscreen')?.getAttribute('aria-hidden') === 'false') {
        dibujarRadar(fullscreenCanvas, state.compareSeries, { focused: true });
      }
    }, 120);
  });

  window.compararProfesores = compararProfesores;
})();
