const DATA_URL = "data/voting.json";
const BOUNDARY_URL = "data/ward27_divisions.geojson";
const COLORS = ["#fff5d6", "#ffd985", "#f7ae52", "#ef7d3c", "#d94b3d", "#9f2842", "#61123b"];

const numberFormat = new Intl.NumberFormat("en-US");
const state = {
  records: [],
  boundaries: null,
  electionType: "Primary",
  year: null,
  map: null,
  geoLayer: null,
  legend: null,
};

const elements = {
  electionOptions: document.querySelector("#election-options"),
  electionValue: document.querySelector("#election-value"),
  yearSlider: document.querySelector("#year-slider"),
  yearValue: document.querySelector("#year-value"),
  yearTicks: document.querySelector("#year-ticks"),
  snapshotTitle: document.querySelector("#snapshot-title"),
  totalVotes: document.querySelector("#total-votes"),
  loadingState: document.querySelector("#loading-state"),
  errorState: document.querySelector("#error-state"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function availableTypes() {
  const order = ["Primary", "General"];
  const found = new Set(state.records.map((record) => record.electionType));
  return order.filter((type) => found.has(type));
}

function availableYears(electionType = state.electionType) {
  return [...new Set(
    state.records
      .filter((record) => record.electionType === electionType)
      .map((record) => record.year),
  )].sort((a, b) => a - b);
}

function selectedRecords() {
  return state.records.filter(
    (record) => record.electionType === state.electionType && record.year === state.year,
  );
}

function niceStep(rawStep) {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(rawStep, 1)));
  const fraction = rawStep / exponent;
  const niceFraction = [1, 2, 4, 5, 10].find((candidate) => candidate >= fraction) ?? 10;
  return niceFraction * exponent;
}

function voteScale() {
  const dataMaximum = Math.max(
    ...state.records
      .filter((record) => record.electionType === state.electionType)
      .map((record) => record.voteCount),
    1,
  );
  const step = niceStep(dataMaximum / 4);
  const maximum = Math.ceil(dataMaximum / step) * step;
  const ticks = [];
  for (let value = 0; value <= maximum; value += step) ticks.push(value);
  return { maximum, ticks };
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function interpolateColor(startHex, endHex, amount) {
  const start = hexToRgb(startHex);
  const end = hexToRgb(endHex);
  const channel = (key) => Math.round(start[key] + (end[key] - start[key]) * amount);
  return `rgb(${channel("r")}, ${channel("g")}, ${channel("b")})`;
}

function colorFor(value, maxValue) {
  if (!Number.isFinite(value)) return "#b7c3ca";
  const ratio = Math.max(0, Math.min(1, value / Math.max(maxValue, 1)));
  const scaled = ratio * (COLORS.length - 1);
  const lowerIndex = Math.floor(scaled);
  const upperIndex = Math.min(COLORS.length - 1, lowerIndex + 1);
  return interpolateColor(COLORS[lowerIndex], COLORS[upperIndex], scaled - lowerIndex);
}

function renderYearTicks(years) {
  elements.yearTicks.replaceChildren();
  years.forEach((year, index) => {
    const tick = document.createElement("span");
    const position = years.length === 1 ? 0 : (index / (years.length - 1)) * 100;
    const showLabel = (year - years[0]) % 2 === 0;
    tick.className = `year-tick${year === state.year ? " is-active" : ""}`;
    tick.style.left = `${position}%`;
    tick.innerHTML = `
      <span class="year-dot"></span>
      ${showLabel ? `<span class="year-tick-label">${year}</span>` : ""}
    `;
    elements.yearTicks.append(tick);
  });
}

function setYearSlider() {
  const years = availableYears();
  if (!years.length) return;

  if (!years.includes(state.year)) {
    state.year = years[years.length - 1];
  }

  const index = years.indexOf(state.year);
  elements.yearSlider.min = "0";
  elements.yearSlider.max = String(years.length - 1);
  elements.yearSlider.value = String(index);
  elements.yearSlider.dataset.years = JSON.stringify(years);
  elements.yearSlider.setAttribute("aria-valuetext", String(state.year));
  elements.yearValue.value = String(state.year);
  elements.yearValue.textContent = String(state.year);
  const progress = years.length === 1 ? 0 : (index / (years.length - 1)) * 100;
  elements.yearSlider.style.setProperty("--slider-progress", `${progress}%`);
  renderYearTicks(years);
}

function renderElectionButtons() {
  elements.electionOptions.replaceChildren();
  for (const type of availableTypes()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment-button";
    button.textContent = type;
    button.setAttribute("aria-pressed", String(type === state.electionType));
    button.addEventListener("click", () => {
      if (state.electionType === type) return;
      state.electionType = type;
      elements.electionValue.textContent = type;
      renderElectionButtons();
      setYearSlider();
      renderMap();
    });
    elements.electionOptions.append(button);
  }
}

function tooltipMarkup(record) {
  return `
    <dl class="tooltip-grid">
      <dt>Division</dt><dd>${escapeHtml(record.division)}</dd>
      <dt>Vote Count</dt><dd>${numberFormat.format(record.voteCount)}</dd>
      <dt>Dorms</dt><dd>${escapeHtml(record.dorms)}</dd>
    </dl>
  `;
}

function updateSnapshot(records) {
  const total = records.reduce((sum, record) => sum + record.voteCount, 0);
  elements.snapshotTitle.textContent = `${state.year} ${state.electionType}`;
  elements.totalVotes.textContent = numberFormat.format(total);
}

function updateLegend(scale) {
  if (state.legend) state.legend.remove();
  state.legend = L.control({ position: "bottomright" });
  state.legend.onAdd = () => {
    const container = L.DomUtil.create("div", "map-legend");
    const gradient = `linear-gradient(90deg, ${COLORS.join(", ")})`;
    container.innerHTML = `
      <strong>Vote Count</strong>
      <small>${escapeHtml(state.electionType)}</small>
      <div class="legend-gradient" style="background:${gradient}"></div>
      <div class="legend-axis">
        ${scale.ticks.map((value) => `<span>${numberFormat.format(value)}</span>`).join("")}
      </div>
    `;
    return container;
  };
  state.legend.addTo(state.map);
}

function renderMap() {
  const records = selectedRecords();
  const byDivision = new Map(records.map((record) => [record.divisionId, record]));
  const scale = voteScale();

  if (state.geoLayer) state.geoLayer.remove();

  state.geoLayer = L.geoJSON(state.boundaries, {
    style(feature) {
      const record = byDivision.get(feature.properties.divisionId);
      return {
        color: "#16394c",
        weight: 1.5,
        opacity: 0.95,
        fillColor: colorFor(record?.voteCount, scale.maximum),
        fillOpacity: 0.78,
      };
    },
    onEachFeature(feature, layer) {
      const record = byDivision.get(feature.properties.divisionId);
      if (!record) return;
      layer.bindTooltip(tooltipMarkup(record), {
        className: "vote-tooltip",
        sticky: true,
        direction: "top",
        opacity: 1,
      });
      layer.on({
        mouseover(event) {
          event.target.setStyle({ weight: 3, color: "#ffffff", fillOpacity: 0.9 });
          event.target.bringToFront();
        },
        mouseout(event) {
          state.geoLayer.resetStyle(event.target);
        },
      });
    },
  }).addTo(state.map);

  updateSnapshot(records);
  updateLegend(scale);
}

function initializeMap() {
  state.map = L.map("map", {
    zoomControl: false,
    minZoom: 11,
    maxZoom: 19,
    scrollWheelZoom: true,
  });
  L.control.zoom({ position: "topright" }).addTo(state.map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);

  const boundaryLayer = L.geoJSON(state.boundaries);
  const bounds = boundaryLayer.getBounds();
  state.map.fitBounds(bounds, { padding: [26, 26] });
  state.map.setMaxBounds(bounds.pad(1.4));
}

function bindControls() {
  elements.yearSlider.addEventListener("input", () => {
    const years = JSON.parse(elements.yearSlider.dataset.years || "[]");
    state.year = years[Number(elements.yearSlider.value)];
    setYearSlider();
    renderMap();
  });
}

async function start() {
  try {
    const [recordsResponse, boundaryResponse] = await Promise.all([
      fetch(DATA_URL),
      fetch(BOUNDARY_URL),
    ]);
    if (!recordsResponse.ok || !boundaryResponse.ok) {
      throw new Error("A required data file was not found.");
    }

    state.records = await recordsResponse.json();
    state.boundaries = await boundaryResponse.json();
    if (!state.records.length || !state.boundaries.features?.length) {
      throw new Error("The generated map data is empty.");
    }

    const types = availableTypes();
    state.electionType = types.includes("Primary") ? "Primary" : types[0];
    const years = availableYears();
    state.year = years[years.length - 1];
    elements.electionValue.textContent = state.electionType;

    renderElectionButtons();
    setYearSlider();
    bindControls();
    initializeMap();
    renderMap();
    elements.loadingState.hidden = true;
  } catch (error) {
    console.error(error);
    elements.loadingState.hidden = true;
    elements.errorState.hidden = false;
  }
}

start();
