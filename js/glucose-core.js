/* ===== Glucose Intelligence — core data logic (DOM-free, testable) ===== */

const MGDL_PER_MMOL = 18.0182;
const BOUND = { vlow: 54, low: 70, high: 180, vhigh: 250 }; // mg/dL

function mgdlToMmol(g) { return g / MGDL_PER_MMOL; }

function parseTimestamp(str) {
  // "23.07.26 12:16" -> epoch ms, treating the wall-clock literally (no timezone shift)
  const parts = str.trim().split(' ');
  const [dd, mm, yy] = parts[0].split('.').map(Number);
  const [hh, mi] = parts[1].split(':').map(Number);
  return Date.UTC(2000 + yy, mm - 1, dd, hh, mi);
}

function normalizeDeviceId(dev){
  if(!dev) return null;
  return String(dev).replace(/^Anytime/i, '').trim() || null;
}

function expandCompact(c, deviceId) {
  const out = new Array(c.values.length);
  const dev = normalizeDeviceId(deviceId);
  for (let i = 0; i < c.values.length; i++) {
    const mgdl = c.values[i];
    out[i] = { t: c.start + i * c.interval, mgdl, mmol: mgdlToMmol(mgdl), dev };
  }
  return out;
}

function parseAnytimeCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const out = [];
  let deviceId = null;
  for (let i = 1; i < lines.length; i++) { // skip header row
    const cols = lines[i].split(';').map(c => c.trim());
    if (cols.length < 4) continue;
    const glu = parseInt(cols[3], 10);
    if (!Number.isFinite(glu) || glu <= 0) continue; // drop sensor warm-up / invalid zeros
    const t = parseTimestamp(cols[2]);
    if (!Number.isFinite(t)) continue;
    if (deviceId === null && cols[1]) deviceId = normalizeDeviceId(cols[1]);
    out.push({ t, mgdl: glu, mmol: mgdlToMmol(glu), dev: deviceId });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function band(mgdl) {
  if (mgdl < BOUND.vlow) return 'vlow';
  if (mgdl < BOUND.low) return 'low';
  if (mgdl <= BOUND.high) return 'target';
  if (mgdl <= BOUND.vhigh) return 'high';
  return 'vhigh';
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdev(arr, m) {
  if (arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function percentile(sortedArr, p) {
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function computeActivePct(readings) {
  if (readings.length < 2) return 100;
  let totalExpected = 0, totalActual = 0, sessionStart = 0;
  const GAP_BREAK = 30 * 60000; // >30 min gap = new wear session
  const MODAL_INTERVAL = 180000; // 3 min, known device cadence
  for (let i = 1; i <= readings.length; i++) {
    const gap = i < readings.length ? readings[i].t - readings[i - 1].t : Infinity;
    if (gap > GAP_BREAK || i === readings.length) {
      const session = readings.slice(sessionStart, i);
      const span = session[session.length - 1].t - session[0].t;
      const expected = Math.round(span / MODAL_INTERVAL) + 1;
      totalExpected += expected;
      totalActual += session.length;
      sessionStart = i;
    }
  }
  return totalExpected ? Math.min(100, (totalActual / totalExpected) * 100) : 100;
}

function computeStats(readings) {
  const mgdlVals = readings.map(r => r.mgdl);
  const n = mgdlVals.length;
  const m = mean(mgdlVals);
  const sd = stdev(mgdlVals, m);
  const cv = (sd / m) * 100;
  const gmi = 3.31 + 0.02392 * m;
  const bandsCount = { vlow: 0, low: 0, target: 0, high: 0, vhigh: 0 };
  for (const g of mgdlVals) bandsCount[band(g)]++;
  const bandsPct = {};
  for (const k in bandsCount) bandsPct[k] = (bandsCount[k] / n) * 100;
  const gri = Math.min((3.0 * bandsPct.vlow) + (2.4 * bandsPct.low) + (1.6 * bandsPct.vhigh) + (0.8 * bandsPct.high), 100);
  const span = readings[n - 1].t - readings[0].t;
  const active = computeActivePct(readings);
  return {
    n, meanMgdl: m, meanMmol: mgdlToMmol(m), sd, sdMmol: mgdlToMmol(sd), cv, gmi,
    bandsPct, gri, active,
    first: readings[0], last: readings[n - 1],
    spanDays: span / 86400000
  };
}

function dayKeyOf(t) {
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function computeDaily(readings) {
  const map = new Map();
  for (const r of readings) {
    const k = dayKeyOf(r.t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const days = [];
  for (const [k, arr] of map) {
    const mgdlVals = arr.map(r => r.mgdl);
    const n = mgdlVals.length;
    const m = mean(mgdlVals);
    const inRange = mgdlVals.filter(g => g >= BOUND.low && g <= BOUND.high).length;
    const low = mgdlVals.filter(g => g < BOUND.low).length;
    const high = mgdlVals.filter(g => g > BOUND.high).length;
    days.push({
      key: k, date: new Date(arr[0].t), readings: arr, n,
      meanMmol: mgdlToMmol(m),
      minMmol: mgdlToMmol(Math.min(...mgdlVals)),
      maxMmol: mgdlToMmol(Math.max(...mgdlVals)),
      tirPct: (inRange / n) * 100, lowPct: (low / n) * 100, highPct: (high / n) * 100
    });
  }
  days.sort((a, b) => a.key.localeCompare(b.key));
  return days;
}

function computeAGPBuckets(readings, bucketMin) {
  bucketMin = bucketMin || 15;
  const nBuckets = Math.round((24 * 60) / bucketMin);
  const buckets = Array.from({ length: nBuckets }, () => []);
  for (const r of readings) {
    const d = new Date(r.t);
    const mod = d.getUTCHours() * 60 + d.getUTCMinutes();
    const b = Math.min(nBuckets - 1, Math.floor(mod / bucketMin));
    buckets[b].push(r.mmol);
  }
  const result = new Array(nBuckets).fill(null);
  for (let i = 0; i < nBuckets; i++) {
    if (buckets[i].length === 0) continue;
    const arr = buckets[i].slice().sort((a, b) => a - b);
    result[i] = {
      p5: percentile(arr, 5), p25: percentile(arr, 25), p50: percentile(arr, 50),
      p75: percentile(arr, 75), p95: percentile(arr, 95), n: arr.length
    };
  }
  // fill any empty buckets (sparse data) via nearest neighbor
  for (let i = 0; i < nBuckets; i++) {
    if (result[i] !== null) continue;
    let j = i - 1; while (j >= 0 && result[j] === null) j--;
    let k = i + 1; while (k < nBuckets && result[k] === null) k++;
    if (j >= 0 && k < nBuckets) result[i] = result[j]; // fallback to previous
    else if (j >= 0) result[i] = result[j];
    else if (k < nBuckets) result[i] = result[k];
  }
  return { bucketMin, nBuckets, buckets: result };
}

function smoothField(bucketsArr, field, window) {
  window = window || 2;
  const n = bucketsArr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let k = -window; k <= window; k++) {
      const idx = ((i + k) % n + n) % n; // wrap across midnight
      if (bucketsArr[idx]) { sum += bucketsArr[idx][field]; count++; }
    }
    out[i] = count ? sum / count : (bucketsArr[i] ? bucketsArr[i][field] : 0);
  }
  return out;
}

function countEpisodes(readings, pred) {
  let count = 0, inRun = false, curLen = 0, maxLen = 0, maxStart = null, curStart = null;
  for (const r of readings) {
    if (pred(r.mgdl)) {
      if (!inRun) { count++; inRun = true; curLen = 0; curStart = r.t; }
      curLen++;
      if (curLen > maxLen) { maxLen = curLen; maxStart = curStart; }
    } else { inRun = false; curLen = 0; }
  }
  return { count, maxLenMinutes: maxLen * 3, maxStart };
}

function computeInsights(readings) {
  const insights = [];

  let wd = [], we = [];
  for (const r of readings) {
    const d = new Date(r.t).getUTCDay();
    (d === 0 || d === 6 ? we : wd).push(r.mmol);
  }
  if (wd.length && we.length) {
    insights.push({
      key: 'weekday',
      title: 'Будні проти вихідних',
      detail: `Будні: ${mean(wd).toFixed(1)} ммоль/л\nВихідні: ${mean(we).toFixed(1)} ммоль/л`,
    });
  }

  const hourLowCounts = Array(24).fill(0), hourTotal = Array(24).fill(0);
  for (const r of readings) {
    const h = new Date(r.t).getUTCHours();
    hourTotal[h]++;
    if (r.mgdl < BOUND.low) hourLowCounts[h]++;
  }
  const hourLowPct = hourLowCounts.map((c, i) => hourTotal[i] ? (c / hourTotal[i]) * 100 : 0);
  let worstHour = 0;
  for (let i = 1; i < 24; i++) if (hourLowPct[i] > hourLowPct[worstHour]) worstHour = i;
  if (hourLowPct[worstHour] > 0) {
    insights.push({
      key: 'lowhour',
      title: 'Вікно підвищеного ризику гіпоглікемії',
      detail: `${String(worstHour).padStart(2, '0')}:00–${String((worstHour + 1) % 24).padStart(2, '0')}:00 — ${hourLowPct[worstHour].toFixed(0)}% вимірів у цій годині нижче цілі`,
    });
  }

  const hypo = countEpisodes(readings, g => g < BOUND.low);
  const hyper = countEpisodes(readings, g => g > BOUND.high);
  insights.push({
    key: 'episodes',
    title: 'Епізоди поза діапазоном',
    detail: `${hypo.count} гіпоглікемічних (макс. ${hypo.maxLenMinutes} хв поспіль) · ${hyper.count} гіперглікемічних (макс. ${hyper.maxLenMinutes} хв поспіль)`,
  });

  let minR = readings[0], maxR = readings[0];
  for (const r of readings) { if (r.mgdl < minR.mgdl) minR = r; if (r.mgdl > maxR.mgdl) maxR = r; }
  insights.push({
    key: 'extremes',
    title: 'Крайні значення періоду',
    detail: `Мінімум ${minR.mmol.toFixed(1)} ммоль/л (${fmtDateTime(minR.t)}) · Максимум ${maxR.mmol.toFixed(1)} ммоль/л (${fmtDateTime(maxR.t)})`,
  });

  return insights;
}

function detectAnomalies(readings) {
  const anomalies = [];
  const MAX_GAP = 6 * 60000; // ignore across session breaks
  const JUMP_THRESHOLD = 50; // mg/dL in one 3-min step ~ well beyond plausible interstitial kinetics
  const FLAT_MIN_RUN = 8; // >=8 identical consecutive readings = 24+ min exact flatline (calibrated: normal quiet periods rarely exceed this)

  for (let i = 1; i < readings.length; i++) {
    const dt = readings[i].t - readings[i - 1].t;
    if (dt > MAX_GAP) continue;
    const delta = readings[i].mgdl - readings[i - 1].mgdl;
    if (Math.abs(delta) >= JUMP_THRESHOLD) {
      const deltaMmol = delta / MGDL_PER_MMOL;
      anomalies.push({
        t: readings[i].t, type: 'jump', mgdl: readings[i].mgdl, delta, dev: readings[i].dev,
        detail: `Стрибок ${deltaMmol > 0 ? '+' : ''}${deltaMmol.toFixed(1)} ммоль/л за ${Math.round(dt / 60000)} хв`
      });
    }
  }

  let runStart = 0;
  for (let i = 1; i <= readings.length; i++) {
    const contiguous = i < readings.length && (readings[i].t - readings[i - 1].t) <= MAX_GAP;
    const same = contiguous && readings[i].mgdl === readings[runStart].mgdl;
    if (!same) {
      const runLen = i - runStart;
      if (runLen >= FLAT_MIN_RUN) {
        anomalies.push({
          t: readings[runStart].t, type: 'flatline', mgdl: readings[runStart].mgdl, runLen, dev: readings[runStart].dev,
          detail: `Плато ${mgdlToMmol(readings[runStart].mgdl).toFixed(1)} ммоль/л упродовж ${runLen * 3} хв`
        });
      }
      runStart = i;
    }
  }

  anomalies.sort((a, b) => b.t - a.t);
  return anomalies;
}

function computeWeeklyTrend(readings) {
  if (readings.length === 0) return [];
  const firstT = readings[0].t;
  const weekMs = 7 * 86400000;
  const buckets = new Map();
  for (const r of readings) {
    const weekIdx = Math.floor((r.t - firstT) / weekMs);
    if (!buckets.has(weekIdx)) buckets.set(weekIdx, []);
    buckets.get(weekIdx).push(r);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([weekIdx, arr]) => {
    const mgdlVals = arr.map(r => r.mgdl);
    const m = mean(mgdlVals);
    const inRange = mgdlVals.filter(g => g >= BOUND.low && g <= BOUND.high).length;
    return {
      weekIdx, n: arr.length,
      startT: arr[0].t, endT: arr[arr.length - 1].t,
      meanMmol: mgdlToMmol(m),
      tirPct: (inRange / arr.length) * 100
    };
  });
}

function detectGaps(readings) {
  const gaps = [];
  const MIN_GAP = 6 * 60000;       // more than one missed reading at ~3min cadence
  const MAX_GAP = 12 * 60 * 60000; // beyond this it's a sensor session boundary, not a data gap
  for (let i = 1; i < readings.length; i++) {
    const dt = readings[i].t - readings[i - 1].t;
    if (dt > MIN_GAP && dt <= MAX_GAP) {
      gaps.push({
        start: readings[i - 1].t, end: readings[i].t,
        durationMin: Math.round(dt / 60000),
        dev: readings[i - 1].dev
      });
    }
  }
  return gaps;
}

function fmtDateTime(t) {
  const d = new Date(t);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm}, ${hh}:${mi}`;
}

function trendArrow(readings) {
  const n = readings.length;
  const last = readings[n - 1];
  const idxBack = Math.max(0, n - 6); // ~15 min back at 3-min cadence
  const prev = readings[idxBack];
  const deltaPer15 = last.mmol - prev.mmol;
  let arrow = '→', label = 'стабільно';
  if (deltaPer15 > 1.0) { arrow = '↑'; label = 'швидко зростає'; }
  else if (deltaPer15 > 0.3) { arrow = '↗'; label = 'зростає'; }
  else if (deltaPer15 < -1.0) { arrow = '↓'; label = 'швидко знижується'; }
  else if (deltaPer15 < -0.3) { arrow = '↘'; label = 'знижується'; }
  return { arrow, label, deltaPer15 };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MGDL_PER_MMOL, BOUND, mgdlToMmol, parseTimestamp, expandCompact, parseAnytimeCSV, normalizeDeviceId,
    band, mean, stdev, percentile, computeStats, computeActivePct, dayKeyOf, computeDaily,
    computeAGPBuckets, smoothField, countEpisodes, computeInsights, detectAnomalies, computeWeeklyTrend, detectGaps,
    fmtDateTime, trendArrow
  };
}
