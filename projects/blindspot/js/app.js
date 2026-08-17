const ALL_REGIONS = "All regions";
const REGIONS = ["PG&E", "SCE", "SDG&E"];
const SERIES_COLOR = {
  "PG&E": "#2a78d6",
  "SCE": "#eb6834",
  "SDG&E": "#1baf7a",
};
// The worst-swing chart is two quantities, not three regions, so it gets its
// own pair: metered demand reads as the solid, factual one; hidden generation
// as the lighter band sitting on top of it.
const DEMAND_COLOR = "#5b5a54";
const HIDDEN_COLOR = "#e0a32e";

const fmtPercent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const fmtDateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });
const fmtLongDate = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const fmtHour = new Intl.DateTimeFormat("en-US", { hour: "numeric" });
const fmtMw = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// The exported timestamps are already California wall-clock time (see
// export_data.py). Swapping the space for a "T" makes them parse as local
// time per spec, rather than relying on browser-specific handling of the
// space-separated form.
function parseLocal(text) {
  return new Date(text.replace(" ", "T"));
}

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
function mountChart(containerId, plot, ariaLabel, srTable, legend) {
  const visual = document.createElement("div");
  visual.className = "chart-visual";
  visual.setAttribute("role", "img");
  visual.setAttribute("aria-label", ariaLabel);
  plot.setAttribute("aria-hidden", "true");
  visual.appendChild(plot);

  const children = [visual];
  if (legend) children.unshift(legend);
  if (srTable) children.push(srTable);
  document.getElementById(containerId).replaceChildren(...children);
}

// A plain swatch legend, used where the series are two named quantities rather
// than a color scale Plot would generate a legend for on its own.
function buildLegend(entries) {
  const wrap = document.createElement("ul");
  wrap.className = "chart-legend";
  wrap.setAttribute("aria-hidden", "true");
  for (const { color, label } of entries) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color;
    item.append(swatch, document.createTextNode(label));
    wrap.appendChild(item);
  }
  return wrap;
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} responded with ${response.status}`);
  return response.json();
}

async function main() {
  const status = document.getElementById("status");

  let summary, hourly, swingDay;
  try {
    [summary, hourly, swingDay] = await Promise.all([
      fetchJson("data/summary.json"),
      fetchJson("data/hourly_generation.json"),
      fetchJson("data/worst_swing_day.json"),
    ]);
  } catch (err) {
    console.error("Failed to load Blind Spot Index data:", err);
    status.textContent = "Couldn't load the data for this page. Try refreshing, or check back shortly.";
    status.dataset.state = "error";
    status.setAttribute("role", "alert");
    return;
  }
  status.hidden = true;

  hourly.forEach((d) => (d.hour_timestamp_local = parseLocal(d.hour_timestamp_local)));
  swingDay.forEach((d) => (d.hour_timestamp_local = parseLocal(d.hour_timestamp_local)));
  const hourlyWide = pivotHourly(hourly);

  // One lookup covering both the three territories and the aggregated total,
  // so every renderer takes the same shaped row either way.
  const rowsByRegion = new Map(summary.regions.map((row) => [row.region_name, row]));
  rowsByRegion.set(ALL_REGIONS, summary.all_regions);

  const select = document.getElementById("region-select");
  for (const name of [ALL_REGIONS, ...summary.regions.map((r) => r.region_name)]) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }

  const render = () => {
    const region = select.value;
    const row = rowsByRegion.get(region);
    renderKpis(row);
    renderIndexChart(summary.regions);
    renderSwingChart(swingDay, row);
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

// "All regions" is a real coincident total, so it needs sentence wording that
// says so rather than being slotted in where a territory's name would go.
function regionPhrase(regionName) {
  return regionName === ALL_REGIONS ? "All three territories combined" : regionName;
}

function renderKpis(row) {
  const isAll = row.region_name === ALL_REGIONS;
  const swingAt = parseLocal(row.swing_hour_local);

  const cards = [
    {
      label: "Blind Spot Index",
      value: fmtPercent.format(row.blind_spot_index),
      note: isAll
        ? `The worst one-hour loss of rooftop solar across all three at once (${fmtMw.format(row.swing_mw)} MW), ` +
          `measured against their coincident peak demand of ${fmtMw.format(row.peak_demand_mw)} MW.`
        : `${row.region_name}'s worst one-hour loss of rooftop solar (${fmtMw.format(row.swing_mw)} MW) ` +
          `measured against peak demand of ${fmtMw.format(row.peak_demand_mw)} MW.`,
    },
    {
      label: "Hidden share at midday",
      value: fmtPercent.format(row.midday_hidden_share),
      note:
        "Share of the electricity actually being consumed between 11 a.m. and 2 p.m. that " +
        "comes from rooftop solar, and so never shows up as demand.",
    },
    {
      label: "Biggest one-hour drop",
      value: `${fmtMw.format(row.swing_mw)} MW`,
      note: `${fmtLongDate.format(swingAt)}, in the hour ending ${fmtHour.format(swingAt)}.`,
    },
    {
      label: "Cloud-driven swing days",
      value: fmtMw.format(row.cloud_event_days),
      note:
        "Days in 2025 when rooftop output fell by at least 5% of peak demand in one hour " +
        "while the sun was still well up. Sunset is excluded: it is scheduled.",
    },
    {
      label: "Demand rise per 10% more cloud",
      value: `+${fmtMw.format(row.sensitivity_rate * 0.1)} MW`,
      note: isAll
        ? "The three territories' separately fitted rates, added together, so this assumes all " +
          "three cloud over at once. R² differs per territory: see each one individually."
        : `Measured from real demand, holding temperature, weekends, and holidays fixed. ` +
          `R² ${row.r_squared.toFixed(2)}, and the relationship is statistically significant.`,
    },
    {
      label: "Rooftop solar installed",
      value: `${fmtMw.format(row.capacity_mw)} MW`,
      note: "Behind-the-meter capacity across homes and commercial buildings alike.",
    },
  ];

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
    const noteEl = document.createElement("div");
    noteEl.className = "note";
    noteEl.textContent = note;
    card.append(labelEl, valueEl, noteEl);
    container.appendChild(card);
  }
}

function renderIndexChart(regions) {
  const width = getContainerWidth("chart-index", 850);
  const plot = Plot.plot({
    width,
    height: 260,
    marginLeft: 55,
    x: { label: null },
    y: { label: "Share of peak demand", percent: true, grid: true },
    marks: [
      Plot.ruleY([0], { stroke: "var(--baseline)" }),
      Plot.barY(regions, {
        x: "region_name",
        y: "blind_spot_index",
        fill: (d) => SERIES_COLOR[d.region_name],
        rx: 4,
      }),
      Plot.text(regions, {
        x: "region_name",
        y: "blind_spot_index",
        text: (d) => fmtPercent.format(d.blind_spot_index),
        dy: -8,
        fill: "var(--text-primary)",
      }),
      Plot.tip(
        regions,
        Plot.pointer({
          x: "region_name",
          y: "blind_spot_index",
          title: (d) =>
            `${d.region_name}\nBlind Spot Index: ${fmtPercent.format(d.blind_spot_index)}\n` +
            `Worst one-hour drop: ${fmtMw.format(d.swing_mw)} MW\n` +
            `Peak demand: ${fmtMw.format(d.peak_demand_mw)} MW`,
        })
      ),
    ],
  });

  const ariaLabel = `Bar chart. Worst one-hour loss of rooftop solar as a share of peak demand: ${regions
    .map((d) => `${d.region_name} ${fmtPercent.format(d.blind_spot_index)}`)
    .join(", ")}.`;
  const srTable = buildSrTable(
    "Blind Spot Index by territory",
    ["Territory", "Blind Spot Index", "Worst one-hour drop (MW)", "Peak demand (MW)"],
    regions.map((d) => [
      d.region_name,
      fmtPercent.format(d.blind_spot_index),
      fmtMw.format(d.swing_mw),
      fmtMw.format(d.peak_demand_mw),
    ])
  );
  mountChart("chart-index", plot, ariaLabel, srTable);
}

// The single day behind the headline number: metered demand, with estimated
// rooftop generation stacked on top of it as a band. The band is the part
// nobody measures, and watching it collapse while the metered line climbs is
// the whole thesis in one picture.
function renderSwingChart(swingDay, row) {
  const region = row.region_name;
  const data = swingDay.filter((d) => d.region_name === region);
  const width = getContainerWidth("chart-swing", 850);
  const swingAt = parseLocal(row.swing_hour_local);

  const priorHour = data.find((d) => +d.hour_timestamp_local === +swingAt - 3600e3);
  const swingHour = data.find((d) => +d.hour_timestamp_local === +swingAt);
  const demandRise = swingHour && priorHour ? swingHour.demand_mw - priorHour.demand_mw : null;

  document.getElementById("swing-region-label").textContent = region;
  document.getElementById("swing-caption").textContent =
    `${regionPhrase(region)}, ${fmtLongDate.format(swingAt)}. The dark line is demand exactly as the grid ` +
    `operator measured it. The gold band above it is the electricity rooftop solar was ` +
    `supplying at the same time, which the operator never sees. In the hour ending ` +
    `${fmtHour.format(swingAt)} the band collapses by ${fmtMw.format(row.swing_mw)} MW` +
    (demandRise > 0
      ? `, and the measured line climbs ${fmtMw.format(demandRise)} MW as load the panels had ` +
        `been covering lands back on the grid.`
      : `.`);

  const plot = Plot.plot({
    width,
    height: 300,
    marginLeft: 65,
    x: { label: null, type: "time" },
    y: { label: "MW", grid: true, zero: true, tickFormat: (v) => fmtMw.format(v) },
    marks: [
      Plot.areaY(data, {
        x: "hour_timestamp_local",
        y1: "demand_mw",
        y2: (d) => d.demand_mw + d.btm_mw,
        fill: HIDDEN_COLOR,
        fillOpacity: 0.35,
      }),
      Plot.lineY(data, {
        x: "hour_timestamp_local",
        y: (d) => d.demand_mw + d.btm_mw,
        stroke: HIDDEN_COLOR,
        strokeWidth: 1.5,
      }),
      Plot.lineY(data, {
        x: "hour_timestamp_local",
        y: "demand_mw",
        stroke: DEMAND_COLOR,
        strokeWidth: 2.5,
      }),
      Plot.ruleX([swingAt], { stroke: "var(--baseline)", strokeDasharray: "3,3" }),
      Plot.tip(
        data,
        Plot.pointerX({
          x: "hour_timestamp_local",
          y: (d) => d.demand_mw + d.btm_mw,
          title: (d) =>
            `${fmtDateTime.format(d.hour_timestamp_local)}\n` +
            `Measured demand: ${fmtMw.format(d.demand_mw)} MW\n` +
            `Hidden rooftop solar: ${fmtMw.format(d.btm_mw)} MW`,
        })
      ),
    ],
  });

  const ariaLabel =
    `Area chart. ${regionPhrase(region)} on ${fmtLongDate.format(swingAt)}. Measured demand with estimated ` +
    `rooftop solar generation stacked above it. The rooftop band falls ${fmtMw.format(row.swing_mw)} MW ` +
    `in the hour ending ${fmtHour.format(swingAt)}` +
    (demandRise > 0 ? `, while measured demand rises ${fmtMw.format(demandRise)} MW.` : `.`);
  const srTable = buildSrTable(
    `${regionPhrase(region)}, hourly demand and estimated rooftop solar on ${fmtLongDate.format(swingAt)}`,
    ["Hour", "Measured demand (MW)", "Hidden rooftop solar (MW)"],
    data.map((d) => [
      fmtDateTime.format(d.hour_timestamp_local),
      fmtMw.format(d.demand_mw),
      fmtMw.format(d.btm_mw),
    ])
  );
  const legend = buildLegend([
    { color: DEMAND_COLOR, label: "Demand the operator measures" },
    { color: HIDDEN_COLOR, label: "Rooftop solar it doesn't" },
  ]);
  mountChart("chart-swing", plot, ariaLabel, srTable, legend);
}

function renderTrendChart(hourly, hourlyWide, region) {
  document.getElementById("trend-region-label").textContent = region;
  if (region === ALL_REGIONS) renderAllRegionsTrend(hourlyWide);
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
    y: { label: "Estimated rooftop solar output (MW)", grid: true, tickFormat: (v) => fmtMw.format(v) },
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
  const ariaLabel =
    `Line chart. Estimated rooftop solar output for ${region} across every hour of 2025, following a ` +
    `daily sunrise-to-sunset cycle within a seasonal arc that is highest in summer. ` +
    `Peaks at ${fmtMw.format(peak.estimated_btm_generation_mw)} MW around ` +
    `${fmtDateTime.format(peak.hour_timestamp_local)}, and falls to zero every night.`;
  mountChart("chart-trend", plot, ariaLabel, null);
}

// Three overlaid lines at 8,760 points each render as dense fills that read as
// a stacked chart, which they are not -- and the eye reliably misreads the
// front series as the top of a stack. So "All regions" plots the combined
// total as one series instead, consistent with every other all-regions figure
// on the page being a real coincident total rather than three things at once.
function renderAllRegionsTrend(hourlyWide) {
  const width = getContainerWidth("chart-trend", 850);
  const data = hourlyWide.map((d) => ({
    hour_timestamp_local: d.hour_timestamp_local,
    total_mw: REGIONS.reduce((sum, r) => sum + (d[r] ?? 0), 0),
  }));

  const plot = Plot.plot({
    width,
    height: 280,
    marginLeft: 65,
    x: { label: null },
    y: { label: "Estimated rooftop solar output (MW)", grid: true, tickFormat: (v) => fmtMw.format(v) },
    marks: [
      Plot.areaY(data, { x: "hour_timestamp_local", y: "total_mw", fill: HIDDEN_COLOR, fillOpacity: 0.15 }),
      Plot.lineY(data, { x: "hour_timestamp_local", y: "total_mw", stroke: HIDDEN_COLOR, strokeWidth: 2 }),
      Plot.tip(
        hourlyWide,
        Plot.pointerX({
          x: "hour_timestamp_local",
          y: (d) => REGIONS.reduce((sum, r) => sum + (d[r] ?? 0), 0),
          title: (d) =>
            [
              fmtDateTime.format(d.hour_timestamp_local),
              `All three: ${fmtMw.format(REGIONS.reduce((sum, r) => sum + (d[r] ?? 0), 0))} MW`,
              ...REGIONS.map((r) => `${r}: ${fmtMw.format(d[r])} MW`),
            ].join("\n"),
        })
      ),
    ],
  });

  const peak = extremeBy(data, "total_mw", (a, b) => a > b);
  const ariaLabel =
    `Line chart. Estimated rooftop solar output for all three territories combined, across every hour ` +
    `of 2025, following a daily sunrise-to-sunset cycle within a seasonal arc that is highest in summer. ` +
    `Peaks at ${fmtMw.format(peak.total_mw)} MW around ${fmtDateTime.format(peak.hour_timestamp_local)}, ` +
    `and falls to zero every night.`;
  mountChart("chart-trend", plot, ariaLabel, null);
}

main();
