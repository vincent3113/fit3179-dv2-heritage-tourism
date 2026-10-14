// Relative URLs work locally and below a GitHub Pages project path.
const pageBase = new URL(".", document.baseURI).href;
const charts = [
  {
    id: "chart-01",
    specUrl: "./specs/01-heritage-dot-map.vg.json",
    dataFiles: ["australia-states.topojson", "heritage-place-points.csv", "state-label-points.csv"]
  },
  {id:"chart-02", specUrl:"./specs/02-heritage-class-lollipop.vg.json", dataFiles:["heritage-place-points.json"]},
  {id:"chart-12", specUrl:"./specs/12-heritage-state-comparison.vg.json", dataFiles:["heritage-state-class.json"]},
  {id:"chart-03", specUrl:"./specs/03-heritage-class-choropleth.vg.json", dataFiles:["heritage-state-class.csv","australia-states.topojson","state-label-points.csv"]},
  {id:"chart-04", specUrl:"./specs/04-first-nations-state-symbols.vg.json", dataFiles:["australia-states.topojson","first-nations-state-counts.csv"]},
  {id:"chart-05", specUrl:"./specs/05-international-participation-waffle.vg.json", dataFiles:["first-nations-international-participation.json"]},
  {id:"chart-11", specUrl:"./specs/11-first-nations-activity-matrix.vg.json", dataFiles:["first-nations-activities.json"]},
  {id:"chart-06", specUrl:"./specs/06-international-activity-connected-dots.vg.json", dataFiles:["first-nations-activities.json"]},
  {id:"chart-07", specUrl:"./specs/07-domestic-first-nations-timeline.vg.json", dataFiles:["first-nations-annual.json"]},
  {id:"chart-08", specUrl:"./specs/08-nsw-activity-grouped-bars.vg.json", dataFiles:["nsw-activities.json"]},
  {id:"chart-09", specUrl:"./specs/09-nsw-stay-length-bars.vg.json", dataFiles:["nsw-overnight-trip-length.json"]},
  {id:"chart-10", specUrl:"./specs/10-nsw-quarterly-grouped-columns.vg.json", dataFiles:["nsw-quarterly-visitation.json"]}
];

const dataCache = new Map();
const rawDataCache = new Map();
const chartResults = new Map();
const stateNames = {
  NSW: "New South Wales",
  VIC: "Victoria",
  QLD: "Queensland",
  WA: "Western Australia",
  SA: "South Australia",
  TAS: "Tasmania",
  NT: "Northern Territory",
  ACT: "Australian Capital Territory"
};

// Parse only known columns. Automatic inference can turn source metadata into dates.
const csvParse = {
  "heritage-place-points.csv": {place_id:"number", longitude:"number", latitude:"number",
    source_feature_count:"number", location_source_object_id:"number", approx_source_flag:"boolean", registration_date:"string"},
  "state-label-points.csv": {longitude:"number", latitude:"number"},
  "first-nations-state-counts.csv": {longitude:"number", latitude:"number", avg_annual_fn_domestic_overnight_trips_reported:"number"},
  "heritage-state-class.csv": {listed_places:"number", historic_places:"number", indigenous_places:"number", natural_places:"number",
    historic_share_pct:"number", indigenous_share_pct:"number", natural_share_pct:"number"}
};

// Validate the complete dataset before drawing. Bad inputs must not look like zeros.
function validateData(fileName, value) {
  if (fileName === "heritage-place-points.json" || fileName === "heritage-place-points.csv") {
    if (!Array.isArray(value) || value.length !== 120) {
      throw new Error("The heritage dataset must contain all 120 places.");
    }
    const ids = new Set();
    for (const row of value) {
      if (!Number.isInteger(row.place_id)) {
        throw new Error("A heritage place has an invalid place ID.");
      }
      if (ids.has(row.place_id)) {
        throw new Error("The heritage dataset contains a duplicate place ID.");
      }
      ids.add(row.place_id);
      if (!Number.isFinite(row.longitude) || row.longitude < -180 || row.longitude > 180 ||
          !Number.isFinite(row.latitude) || row.latitude < -90 || row.latitude > 90) {
        throw new Error("A heritage place has an invalid longitude or latitude coordinate.");
      }
      const codes = fileName.endsWith(".csv") && typeof row.state_codes === "string"
        ? row.state_codes.split("|") : row.state_codes;
      if (typeof row.name !== "string" || !row.name.trim() ||
          !["Historic", "Natural", "Indigenous"].includes(row.heritage_class) ||
          !Array.isArray(codes) || !codes.length ||
          codes.some(code => !Object.hasOwn(stateNames, code)) ||
          typeof row.approx_source_flag !== "boolean" ||
          typeof row.registration_date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(row.registration_date) ||
          Number.isNaN(Date.parse(row.registration_date))) {
        throw new Error("A heritage place has incomplete name, classification, state or date fields.");
      }
    }
    return value;
  }

  if (fileName === "australia-states.topojson") {
    const geometries = value && value.objects && value.objects.states && value.objects.states.geometries;
    if (value.type !== "Topology" || !Array.isArray(value.arcs) ||
        !Array.isArray(geometries) || geometries.length !== 8) {
      throw new Error("The basemap must contain all eight state and territory geometries.");
    }
    const codes = new Set(geometries.map(row => row.properties && row.properties.state_code));
    if (codes.size !== 8 || [...codes].some(code => !Object.hasOwn(stateNames, code))) {
      throw new Error("The basemap has incomplete or duplicate state keys.");
    }
    for (const geometry of geometries) {
      if (geometry.properties.state_name !== stateNames[geometry.properties.state_code]) {
        throw new Error("The basemap has a state name attached to the wrong geographic key.");
      }
      if (!["Polygon", "MultiPolygon"].includes(geometry.type) || !Array.isArray(geometry.arcs)) {
        throw new Error("The basemap contains an invalid state geometry.");
      }
      const arcIds = geometry.arcs.flat(Infinity);
      if (arcIds.some(index => !Number.isInteger(index) ||
          (index < 0 ? ~index : index) >= value.arcs.length)) {
        throw new Error("The basemap references an invalid geometry arc.");
      }
    }
    return value;
  }

  if (fileName === "heritage-state-class.json" || fileName === "heritage-state-class.csv") {
    validateStateRows(value);
    for (const row of value) {
      const fields = ["historic","indigenous","natural"];
      if (!Number.isInteger(row.listed_places) || row.listed_places <= 0 ||
          fields.some(k => !Number.isInteger(row[k + "_places"]) || row[k + "_places"] < 0) ||
          fields.reduce((total,k) => total + row[k + "_places"],0) !== row.listed_places ||
          fields.some(k => !Number.isFinite(row[k + "_share_pct"]) ||
            Math.abs(row[k + "_share_pct"] - 100 * row[k + "_places"] / row.listed_places) > 1e-8)) {
        throw new Error("State classification totals, counts or shares are inconsistent.");
      }
    }
    return value;
  }
  if (["state-label-points.json", "state-label-points.csv",
       "first-nations-state-counts.json", "first-nations-state-counts.csv"].includes(fileName)) {
    validateStateRows(value);
    if (value.some(r => !Number.isFinite(r.longitude) || Math.abs(r.longitude)>180 ||
        !Number.isFinite(r.latitude) || Math.abs(r.latitude)>90 || r.position_source !== "ABS STE_PT 2026")) {
      throw new Error("State anchor coordinates or source are invalid.");
    }
    if (fileName.startsWith("first-nations-state-counts.") && value.some(r =>
        !Number.isFinite(r.avg_annual_fn_domestic_overnight_trips_reported) ||
        r.avg_annual_fn_domestic_overnight_trips_reported < 0 ||
        r.financial_year_start !== "2021/22" || r.financial_year_end !== "2023/24")) {
      throw new Error("Overnight trip averages or reporting periods are invalid.");
    }
    return value;
  }
  if (fileName === "first-nations-international-participation.json") {
    if (!Array.isArray(value) || value.length !== 3 ||
        new Set(value.map(r=>r.financial_year)).size !== 3 ||
        !value.some(r=>r.financial_year === "2023/24") ||
        value.some(r=>!Number.isFinite(r.international_fn_trips_reported) ||
          !Number.isFinite(r.all_international_trips_reported) ||
          r.international_fn_trips_reported < 0 || r.all_international_trips_reported <= 0 ||
          r.international_fn_trips_reported > r.all_international_trips_reported ||
          !Number.isFinite(r.fn_share_of_all_international_trips_pct_reported) ||
          r.fn_share_of_all_international_trips_pct_reported < 0 || r.fn_share_of_all_international_trips_pct_reported > 100)) {
      throw new Error("The participation dataset is incomplete or has invalid counts or shares.");
    }
    return value;
  }
  if (fileName === "first-nations-activities.json") {
    const ids = ["site_community","art_craft_cultural_displays","traditional_activities","guided_tour","performance","food_experience","camping"];
    if (!Array.isArray(value) || value.length !== 14 ||
        new Set(value.map(r=>r.cohort + ":" + r.activity_id)).size !== 14 ||
        value.some(r=>!["international","domestic_day_and_overnight"].includes(r.cohort) || !ids.includes(r.activity_id) ||
          typeof r.activity_label_source !== "string" || !r.activity_label_source ||
          !Number.isFinite(r.share_of_fn_trips_2023_24_pct_reported) ||
          r.share_of_fn_trips_2023_24_pct_reported < 0 || r.share_of_fn_trips_2023_24_pct_reported > 100 ||
          !Number.isFinite(r.trips_2023_24_reported) || r.trips_2023_24_reported < 0 ||
          ["trips_2017_18_reported","trips_2018_19_reported"].some(k=>r[k] !== null && (!Number.isFinite(r[k]) || r[k] < 0)))) {
      throw new Error("Activity rows, keys, shares or reported counts are invalid.");
    }
    return value;
  }
  if (fileName === "first-nations-annual.json") {
    if (!Array.isArray(value) || value.length !== 11 ||
        new Set(value.map(r=>r.financial_year)).size !== 11 ||
        new Set(value.map(r=>r.period_end_year)).size !== 11 ||
        value.some(r=>!Number.isInteger(r.period_end_year) || r.period_end_year < 2014 || r.period_end_year > 2024 ||
          r.financial_year !== (r.period_end_year-1) + "/" + String(r.period_end_year).slice(2) ||
          !Number.isFinite(r.domestic_fn_trips_reported) || r.domestic_fn_trips_reported < 0 ||
          ["international_fn_trips_reported","total_fn_trips_reported"].some(k=>r[k] !== null && (!Number.isFinite(r[k]) || r[k]<0)))) {
      throw new Error("The annual dataset must contain eleven complete domestic years.");
    }
    return value;
  }
  if (fileName === "nsw-activities.json") {
    const labels = ["Visit museums or art galleries","Go to markets","Attend theatre, concerts or other performing arts","Visit history / heritage buildings, sites or monuments","Attend festivals / fairs or cultural events"];
    if (!Array.isArray(value) || value.length !== 10 ||
        new Set(value.map(r=>r.cohort+":"+r.activity_label_source)).size !== 10 ||
        value.some(r=>!["domestic_overnight","domestic_daytrip"].includes(r.cohort) || !labels.includes(r.activity_label_source) ||
          (r.cohort === "domestic_daytrip" && r.activity_label_source === labels[4]
            ? r.visitor_share_pct_reported !== null || r.missing_reason !== "not_publishable"
            : !Number.isFinite(r.visitor_share_pct_reported) || r.visitor_share_pct_reported < 0 || r.visitor_share_pct_reported > 100))) {
      throw new Error("NSW activity pairs or documented suppression are invalid.");
    }
    return value;
  }
  if (fileName === "nsw-overnight-trip-length.json") {
    const categories = ["1 night","2 nights","3 nights","4 to 7 nights","8 to 14 nights","15 or more nights"];
    if (!Array.isArray(value) || value.length !== 6 ||
        new Set(value.map(r=>r.category)).size !== 6 ||
        value.some((r,i)=>r.cohort !== "domestic_overnight" || r.category !== categories[i] ||
          !Number.isFinite(r.visitor_share_pct_reported) || r.visitor_share_pct_reported < 0 || r.visitor_share_pct_reported > 100)) {
      throw new Error("The six ordered overnight duration groups are incomplete or invalid.");
    }
    return value;
  }
  if (fileName === "nsw-quarterly-visitation.json") {
    if (!Array.isArray(value) || value.length !== 8 ||
        new Set(value.map(r=>r.cohort+":"+r.quarter)).size !== 8 ||
        value.some(r=>!["domestic_overnight","domestic_daytrip"].includes(r.cohort) ||
          ![1,2,3,4].includes(r.quarter) || !Number.isFinite(r.visitor_share_pct_reported) ||
          r.visitor_share_pct_reported < 0 || r.visitor_share_pct_reported > 100)) {
      throw new Error("Both NSW visitor groups must have all four valid quarters.");
    }
    return value;
  }
  throw new Error("No data contract has been implemented for " + fileName + ".");
}

function validateStateRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 8 ||
      new Set(rows.map(r=>r.state_code)).size !== 8 ||
      rows.some(r=>!Object.hasOwn(stateNames,r.state_code) || r.state_name !== stateNames[r.state_code])) {
    throw new Error("The state dataset must contain all eight unique state keys and full names.");
  }
}

// Composition needs real component widths, not CSS scaling of small labels.
function fitStateComparisonLayout(spec, availableWidth) {
  const adjusted = JSON.parse(JSON.stringify(spec));
  const parts = adjusted.hconcat;
  const labelSpace = availableWidth < 520 ? 162 : 220;
  if (availableWidth < 760) {
    delete adjusted.hconcat;
    adjusted.vconcat = parts;
    parts.forEach(part => { part.width = Math.max(120,availableWidth - labelSpace - 42); });
    parts[1].encoding.y.axis = {title:null,labelLimit:220,minExtent:145,
      labelExpr:"datum.label == 'Australian Capital Territory' ? ['Australian Capital','Territory'] : datum.label"};
    parts[0].encoding.y.axis = {...parts[1].encoding.y.axis};
  } else {
    const usable = availableWidth - labelSpace - 78;
    parts[0].width = Math.floor(usable * 0.47);
    parts[1].width = Math.floor(usable * 0.53);
  }
  return adjusted;
}

function setSummary(id, before, value, after) {
  const emphasis = document.createElement("strong");
  emphasis.textContent = value;
  document.getElementById(id).replaceChildren(before, emphasis, after);
}

function updateClassificationSummary(selection, rows) {
  const key = selection.toLowerCase();
  const highest = [...rows].sort((a,b)=>b[key+"_share_pct"]-a[key+"_share_pct"])[0];
  const comparison = rows.find(r=>r.state_code === {Historic:"VIC",Indigenous:"NSW",Natural:"WA"}[selection]);
  document.getElementById("chart-03-subtitle").textContent = selection +
    "-classified places as a share of each state's listed places · Snapshot 4 October 2026";
  setSummary("chart-03-summary", selection + " share: " + highest.state_name + " leads at ",
    highest[key+"_share_pct"].toFixed(1) + "%",
    " (" + highest[key+"_places"] + " of " + highest.listed_places + "). " +
    comparison.state_name + " has " + comparison[key+"_share_pct"].toFixed(1) + "% (" +
    comparison[key+"_places"] + " of " + comparison.listed_places + ").");
}

function updateLatestYearSummary(rows) {
  const row = rows.reduce((latest,r)=>r.period_end_year>latest.period_end_year?r:latest);
  setSummary("chart-07-summary", "July " +
    (row.period_end_year-1) + " to June " + row.period_end_year + ": ",
    row.domestic_fn_trips_reported.toLocaleString("en-AU"),
    " reported domestic day and overnight trips involving First Nations activities.");
}

function populateAnnualTripList(rows) {
  const body = document.getElementById("annual-trip-rows");
  body.replaceChildren();
  for (const row of [...rows].sort((a,b)=>a.period_end_year-b.period_end_year)) {
    const tr = body.insertRow();
    tr.insertCell().textContent = "July " + (row.period_end_year-1) + " to June " + row.period_end_year;
    tr.insertCell().textContent = row.domestic_fn_trips_reported.toLocaleString("en-AU");
  }
}

// The pre-flight and Vega loader share the same successful download.
function loadData(fileName) {
  if (dataCache.has(fileName)) return dataCache.get(fileName);
  const promise = (async () => {
    if (!/^[a-z0-9-]+\.(json|topojson|csv)$/.test(fileName)) {
      throw new Error("The data filename is invalid.");
    }
    let response;
    try {
      response = await fetch(new URL("./data/" + fileName, pageBase));
    } catch (error) {
      throw new Error("Unable to load " + fileName + ". Check your connection.", {cause: error});
    }
    if (!response.ok) {
      throw new Error("Unable to load " + fileName + " (HTTP " + response.status + ").");
    }
    const raw = await response.text();
    const parsed = fileName.endsWith(".csv") ? vega.read(raw, {type:"csv", parse:csvParse[fileName]}) : JSON.parse(raw);
    const value = validateData(fileName, parsed);
    rawDataCache.set(fileName, raw);
    return value;
  })();
  dataCache.set(fileName, promise);
  promise.catch(() => dataCache.delete(fileName));
  return promise;
}

async function embedChart(entry) {
  const container = document.getElementById(entry.id);
  const status = document.getElementById(entry.id + "-status");
  try {
    await Promise.all(entry.dataFiles.map(loadData));
    const loader = vega.loader({baseURL: pageBase});
    const ordinaryLoad = loader.load.bind(loader);
    const dataBase = new URL("./data/", pageBase).href;
    loader.load = async (uri, options) => {
      const resolved = new URL(uri, pageBase).href;
      if (resolved.startsWith(dataBase)) {
        const fileName = resolved.slice(dataBase.length);
        await loadData(fileName);
        return rawDataCache.get(fileName);
      }
      return ordinaryLoad(uri, options);
    };
    // Revalidate specifications so a revised page cannot keep an older chart layout.
    const response = await fetch(new URL(entry.specUrl,pageBase), {cache:"no-cache"});
    if (!response.ok) throw new Error("Unable to load the chart specification: " + response.status);
    let specification = await response.json();
    // Apply the shared reading size after source config, which overrides embed defaults.
    specification.config = {...specification.config,
      axis: {...specification.config?.axis, labelFontSize: 16, titleFontSize: 16}};
    if (entry.id === "chart-12") {
      specification = fitStateComparisonLayout(specification,container.getBoundingClientRect().width);
      if (chartResults.has(entry.id)) chartResults.get(entry.id).finalize();
    }
    const result = await vegaEmbed(container, specification, {
      actions: true,
      renderer: "svg",
      // Source Sans has taller glyph bounds than Vega's default label metrics.
      // Reserve an explicit gap between ticks and titles for every chart.
      config: {
        axis: {titlePadding: 24, labelPadding: 8, labelLineHeight: 24},
        // Account for the local font's glyph bounds, not just Vega's text baselines.
        legend: {titlePadding: 10, labelOffset: 8, columnPadding: 30, rowPadding: 8,
          gradientLength: 250, gradientThickness: 12, gradientLabelOffset: 12, offset: 16}
      },
      loader
    });
    chartResults.set(entry.id, result);
    if (entry.id === "chart-03") {
      // Reuse Vega's native radio inputs before the key, preserving their binding.
      document.getElementById("chart-03-controls").append(container.querySelector(".vega-bindings"));
      const rows = await loadData("heritage-state-class.csv");
      const update = (_,selection) => updateClassificationSummary(selection,rows);
      result.view.addSignalListener("heritageClass",update);
      update(null,result.view.signal("heritageClass"));
    }
    if (entry.id === "chart-07") {
      const rows = await loadData("first-nations-annual.json");
      updateLatestYearSummary(rows);
      populateAnnualTripList(rows);
    }
    container.dataset.state = "ready";
    container.setAttribute("aria-busy", "false");
    status.hidden = true;
    return result;
  } catch (error) {
    container.replaceChildren();
    container.dataset.state = "error";
    container.setAttribute("aria-busy", "false");
    status.hidden = false;
    status.classList.add("is-error");
    status.textContent = "We could not load this chart. " + error.message +
      " Reload the page or use the official source links below.";
    return null;
  }
}

// A slow redraw must finish before another can replace the same Vega view.
// Requests during that work coalesce into one redraw at the latest container width.
let stateComparisonRenderPromise = null;
let stateComparisonNeedsRender = false;
function queueStateComparisonRedraw() {
  stateComparisonNeedsRender = true;
  if (stateComparisonRenderPromise) return stateComparisonRenderPromise;
  stateComparisonRenderPromise = (async () => {
    while (stateComparisonNeedsRender) {
      stateComparisonNeedsRender = false;
      await embedChart(charts.find(chart => chart.id === "chart-12"));
    }
  })().finally(() => { stateComparisonRenderPromise = null; });
  return stateComparisonRenderPromise;
}

async function populatePlaceList() {
  const status = document.getElementById("place-list-status");
  try {
    const rows = await loadData("heritage-place-points.json");
    const fragment = document.createDocumentFragment();
    const dates = new Intl.DateTimeFormat("en-AU", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
    });
    for (const row of [...rows].sort((a, b) => a.name.localeCompare(b.name, "en-AU"))) {
      const tr = document.createElement("tr");
      tr.dataset.placeId = row.place_id;
      const fields = [
        row.name,
        row.state_codes.map(code => stateNames[code]).join(", "),
        row.heritage_class,
        dates.format(new Date(row.registration_date + "T00:00:00Z"))
      ];
      for (const field of fields) {
        const td = document.createElement("td");
        td.textContent = field;
        tr.append(td);
      }
      fragment.append(tr);
    }
    document.getElementById("place-rows").replaceChildren(fragment);
    status.hidden = true;
  } catch (error) {
    status.textContent = "We could not load the place records. " + error.message;
    status.classList.add("is-error");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // Chart labels should measure the real local font, not a temporary fallback.
  if (document.fonts) await document.fonts.ready;
  await Promise.all([populatePlaceList(), ...charts.map(embedChart)]);
  const stateComparison = document.getElementById("chart-12");
  if (stateComparison && typeof ResizeObserver !== "undefined") {
    let lastWidth = Math.round(stateComparison.getBoundingClientRect().width);
    let resizeTimer;
    new ResizeObserver(entries => {
      const width = Math.round(entries[0].contentRect.width);
      if (width === lastWidth) return;
      lastWidth = width;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(queueStateComparisonRedraw,120);
    }).observe(stateComparison);
  }
});
