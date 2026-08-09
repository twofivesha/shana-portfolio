const REGIONS = ["PG&E", "SCE", "SDG&E"];
const SERIES_COLOR = {
  "PG&E": "#2a78d6",
  "SCE": "#eb6834",
  "SDG&E": "#1baf7a",
};

const fmtPercent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const fmtDateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });
const fmtMw = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function getContainerWidth(id, fallback) {
  const width = document.getElementById(id)?.clientWidth;
  return width > 0 ? Math.round(width) : fallback;
}

function buildSrTable(caption, headers, rows) {
  const table = document.createElement("table");
  table.className = "sr-only";
  const captionEl = document.createElement("caption");
  captionEl.textContent = caption;
  table.appendChild(captionEl);

  const headRow = document.createElement("tr");
  headers.forEach((text) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = text;
    headRow.appendChild(th);
  });
  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((cells) => {
    const tr = document.createElement("tr");
    cells.forEach((text) => {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

// Mounts a plotted SVG as an accessible image (role="img" + a text alternative),
// so keyboard and screen-reader users get the chart's meaning without the mouse-only tooltip.
function mountChart(containerId, plot, ariaLabel, srTable) {
  const visual = document.createElement("div");
  visual.className = "chart-visual";
  visual.setAttribute("role", "img");
  visual.setAttribute("aria-label", ariaLabel);
  plot.setAttribute("aria-hidden", "true");
  visual.appendChild(plot);

  const children = srTable ? [visual, srTable] : [visual];
  document.getElementById(containerId).replaceChildren(...children);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} responded with ${response.status}`);
  return response.json();
}

async function main() {
  const status = document.getElementById("status");

  let summary, hourly;
  try {
    [summary, hourly] = await Promise.all([fetchJson("data/summary.json"), fetchJson("data/hourly_generation.json")]);
  } catch (err) {
    console.error("Failed to load Blind Spot Index data:", err);
    status.textContent = "Couldn't load the data for this page. Try refreshing, or check back shortly.";
    status.dataset.state = "error";
    status.setAttribute("role", "alert");
    return;
  }
  status.hidden = true;

  hourly.forEach((d) => (d.hour_timestamp_local = new Date(d.hour_timestamp_local)));
  const hourlyWide = pivotHourly(hourly);

  const select = document.getElementById("region-select");
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "All regions";
  select.appendChild(allOpt);
  summary.forEach((row) => {
    const opt = document.createElement("option");
    opt.value = row.region_name;
    opt.textContent = row.region_name;
    select.appendChild(opt);
  });

  const render = () => {
    const region = select.value;
    renderKpis(summary, region);
    renderIndexChart(summary);
    renderTrendChart(hourly, hourlyWide, region);
  };

  select.addEventListener("change", render);
  render();

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });
}

function pivotHourly(hourly) {
  const byHour = new Map();
  for (const d of hourly) {
    const key = +d.hour_timestamp_local;
    if (!byHour.has(key)) byHour.set(key, { hour_timestamp_local: d.hour_timestamp_local });
    byHour.get(key)[d.region_name] = d.estimated_btm_generation_mw;
  }
  return [...byHour.values()].sort((a, b) => a.hour_timestamp_local - b.hour_timestamp_local);
}

function renderKpis(summary, region) {
  document.getElementById("trend-region-label").textContent = region === "all" ? "all regions" : region;

  let cards;
  if (region === "all") {
    const avg = (key) => summary.reduce((sum, r) => sum + r[key], 0) / summary.length;
    const sum = (key) => summary.reduce((total, r) => total + r[key], 0);
    cards = [
      { label: "Blind Spot Index", value: fmtPercent.format(avg("blind_spot_index")), note: "Unweighted average across regions." },
      { label: "Sensitivity rate (MW / anomaly unit)", value: fmtMw.format(avg("sensitivity_rate")), note: "Unweighted average across regions." },
      { label: "Total installed capacity (MW)", value: fmtMw.format(sum("capacity_mw")), note: "Sum across all three regions." },
    ];
  } else {
    const row = summary.find((r) => r.region_name === region);
    cards = [
      { label: "Blind Spot Index", value: fmtPercent.format(row.blind_spot_index) },
      { label: "Sensitivity rate (MW / anomaly unit)", value: fmtMw.format(row.sensitivity_rate) },
      { label: "Total installed capacity (MW)", value: fmtMw.format(row.capacity_mw) },
    ];
  }

  const container = document.getElementById("kpi-cards");
  container.replaceChildren();
  for (const { label, value, note } of cards) {
    const card = document.createElement("div");
    card.className = "kpi-card";
    const labelEl = document.createElement("div");
    labelEl.className = "label";
    labelEl.textContent = label;
    const valueEl = document.createElement("div");
    valueEl.className = "value";
    valueEl.textContent = value;
    card.append(labelEl, valueEl);
    if (note) {
      const noteEl = document.createElement("div");
      noteEl.className = "note";
      noteEl.textContent = note;
      card.appendChild(noteEl);
    }
    container.appendChild(card);
  }
}

function renderIndexChart(summary) {
  const width = getContainerWidth("chart-index", 850);
  const plot = Plot.plot({
    width,
    height: 260,
    marginLeft: 50,
    x: { label: null },
    y: { label: "Blind Spot Index", percent: true, grid: true },
    marks: [
      Plot.ruleY([0], { stroke: "var(--baseline)" }),
      Plot.barY(summary, {
        x: "region_name",
        y: "blind_spot_index",
        fill: (d) => SERIES_COLOR[d.region_name],
        rx: 4,
      }),
      Plot.text(summary, {
        x: "region_name",
        y: "blind_spot_index",
        text: (d) => fmtPercent.format(d.blind_spot_index),
        dy: -8,
        fill: "var(--text-primary)",
      }),
      Plot.tip(
        summary,
        Plot.pointer({
          x: "region_name",
          y: "blind_spot_index",
          title: (d) => `${d.region_name}\nBlind Spot Index: ${fmtPercent.format(d.blind_spot_index)}\nWorst swing: ${fmtMw.format(d.swing_mw)} MW`,
        })
      ),
    ],
  });

  const ariaLabel = `Bar chart. Blind Spot Index by region: ${summary
    .map((d) => `${d.region_name} ${fmtPercent.format(d.blind_spot_index)}`)
    .join(", ")}.`;
  const srTable = buildSrTable(
    "Blind Spot Index by region",
    ["Region", "Blind Spot Index", "Worst swing (MW)"],
    summary.map((d) => [d.region_name, fmtPercent.format(d.blind_spot_index), fmtMw.format(d.swing_mw)])
  );
  mountChart("chart-index", plot, ariaLabel, srTable);
}

function renderTrendChart(hourly, hourlyWide, region) {
  if (region === "all") renderAllRegionsTrend(hourlyWide);
  else renderSingleRegionTrend(hourly, region);
}

function extremeBy(data, key, comparator) {
  return data.reduce((best, d) => (best === null || comparator(d[key], best[key]) ? d : best), null);
}

function renderSingleRegionTrend(hourly, region) {
  const data = hourly.filter((d) => d.region_name === region);
  const color = SERIES_COLOR[region];
  const width = getContainerWidth("chart-trend", 850);

  const plot = Plot.plot({
    width,
    height: 280,
    marginLeft: 65,
    x: { label: null },
    y: { label: "Estimated BTM generation (MW)", grid: true, tickFormat: (v) => fmtMw.format(v) },
    marks: [
      Plot.areaY(data, { x: "hour_timestamp_local", y: "estimated_btm_generation_mw", fill: color, fillOpacity: 0.1 }),
      Plot.lineY(data, { x: "hour_timestamp_local", y: "estimated_btm_generation_mw", stroke: color, strokeWidth: 2 }),
      Plot.tip(
        data,
        Plot.pointerX({
          x: "hour_timestamp_local",
          y: "estimated_btm_generation_mw",
          title: (d) => `${fmtDateTime.format(d.hour_timestamp_local)}\n${fmtMw.format(d.estimated_btm_generation_mw)} MW`,
        })
      ),
    ],
  });

  const peak = extremeBy(data, "estimated_btm_generation_mw", (a, b) => a > b);
  const trough = extremeBy(data, "estimated_btm_generation_mw", (a, b) => a < b);
  const ariaLabel =
    `Line chart. Estimated behind-the-meter generation for ${region} across 2025, following a daily solar cycle. ` +
    `Peaks at ${fmtMw.format(peak.estimated_btm_generation_mw)} MW around ${fmtDateTime.format(peak.hour_timestamp_local)}, ` +
    `drops to ${fmtMw.format(trough.estimated_btm_generation_mw)} MW overnight around ${fmtDateTime.format(trough.hour_timestamp_local)}.`;
  mountChart("chart-trend", plot, ariaLabel, null);
}

function renderAllRegionsTrend(hourlyWide) {
  const width = getContainerWidth("chart-trend", 850);
  const plot = Plot.plot({
    width,
    height: 280,
    marginLeft: 65,
    x: { label: null },
    y: { label: "Estimated BTM generation (MW)", grid: true, tickFormat: (v) => fmtMw.format(v) },
    color: { domain: REGIONS, range: REGIONS.map((r) => SERIES_COLOR[r]), legend: true },
    marks: [
      ...REGIONS.map((r) =>
        Plot.lineY(hourlyWide, { x: "hour_timestamp_local", y: r, stroke: () => r, strokeWidth: 2 })
      ),
      Plot.tip(
        hourlyWide,
        Plot.pointerX({
          x: "hour_timestamp_local",
          y: "PG&E",
          title: (d) =>
            [fmtDateTime.format(d.hour_timestamp_local), ...REGIONS.map((r) => `${r}: ${fmtMw.format(d[r])} MW`)].join(
              "\n"
            ),
        })
      ),
    ],
  });

  const peaks = REGIONS.map((r) => {
    const peak = extremeBy(hourlyWide, r, (a, b) => a > b);
    return `${r} peaks at ${fmtMw.format(peak[r])} MW`;
  });
  const ariaLabel = `Line chart. Estimated behind-the-meter generation for all regions across 2025, following daily solar cycles. ${peaks.join("; ")}.`;
  mountChart("chart-trend", plot, ariaLabel, null);
}

main();
