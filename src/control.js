// =====================================================================
//  Sterowanie grzałkami (nadwyżka PV) + pompa obiegowa (różnicówka)
//  PV-surplus heater control + differential circulation pump
//  ---------------------------------------------------------------------
//  Wersja / Version: 5.1
//  Zmiany vs 5.0 / Changes vs 5.0:
//   - JSON.parse w try/catch + walidacja body -> brak crasha przy słabym Wi-Fi
//     JSON.parse wrapped in try/catch + body validation -> no crash on flaky Wi-Fi
//   - Tolerancja chwilowych braków odczytu 3EM (EM_MISS_LIMIT) przed fail-safe OFF
//     Tolerance for transient 3EM read misses before fail-safe OFF
//
//  Skrypt na SHELLY 1PM GEN4 (MASTER). Reszta architektury bez zmian /
//  Runs on SHELLY 1PM GEN4 (MASTER). Rest of the architecture unchanged.
// =====================================================================

let CFG = {
  // Adresy IP urządzeń / Device IP addresses
  EM_IP:      "192.168.1.50",   // Shelly Pro 3EM
  TEMPDEV_IP: "192.168.1.60",   // Moduł (CWU2, CWU3) / Module (DHW2, DHW3)
  HEATER1_IP: "192.168.1.101",  // Shelly Pro 3 - grzałka 1 / heater 1
  HEATER2_IP: "192.168.1.102",  // Shelly Pro 3 - grzałka 2 / heater 2
  HEATER3_IP: "192.168.1.103",  // Shelly Pro 3 - grzałka 3 / heater 3

  // Moc / regulacja grzałek — Heater power / control
  STEP_W:       2000,   // moc stopnia [W] / stage power [W]
  POWER_MARGIN: 200,    // margines [W] / safety margin [W]
  EXPORT_SIGN:  -1,     // surplus = EXPORT_SIGN * total_act_power (nadwyżka>0 / surplus>0)
  EM_MISS_LIMIT: 2,     // ile kolejnych braków odczytu 3EM tolerujemy (potem grzałki OFF) /
                        // consecutive 3EM read misses tolerated before heaters OFF

  // Ochrona termiczna bufora — Buffer over-temperature protection
  BUFFER_MAX:   80,     // STOP grzania gdy bufor >= [C] / stop heating when buffer >= [C]  (< 85)
  BUFFER_HYST:  5,      // histereza [C] / hysteresis [C]

  // Pompa obiegowa (różnicówka bufor-CWU) — Circulation pump (buffer-DHW differential)
  PUMP_ON_DIFF:  10,    // ON gdy różnica >= [C] / ON when difference >= [C]
  PUMP_OFF_DIFF: 6,     // OFF gdy różnica < [C] / OFF when difference < [C]
  PUMP_ID:       0,     // lokalny przekaźnik pompy / local pump relay
  CWU_MAX:       65,    // anti-scald: OFF gdy CWU >= [C] / OFF when DHW >= [C]  (0 = wył./off)

  AUTO_OFF_S: 90,       // watchdog auto-off [s]
  POLL_MS:    30000     // cykl / loop period [ms]
};

// Definicja czujników / Sensor map (local:true = MASTER, local:false = MODULE via RPC)
let SENSORS = [
  { key: "buffer", local: true,  id: 100 },  // bufor / buffer  (MASTER)
  { key: "cwu1",   local: true,  id: 101 },  // CWU1 / DHW1      (MASTER)
  { key: "cwu2",   local: false, id: 100 },  // CWU2 / DHW2      (MODUŁ / MODULE)
  { key: "cwu3",   local: false, id: 101 }   // CWU3 / DHW3      (MODUŁ / MODULE)
];

let STEPS = [
  { ip: CFG.HEATER1_IP, id: 0 }, { ip: CFG.HEATER1_IP, id: 1 }, { ip: CFG.HEATER1_IP, id: 2 },
  { ip: CFG.HEATER2_IP, id: 0 }, { ip: CFG.HEATER2_IP, id: 1 }, { ip: CFG.HEATER2_IP, id: 2 },
  { ip: CFG.HEATER3_IP, id: 0 }, { ip: CFG.HEATER3_IP, id: 1 }, { ip: CFG.HEATER3_IP, id: 2 }
];

let activeSteps = 0;
let temps = { buffer: undefined, cwu1: undefined, cwu2: undefined, cwu3: undefined }; // last-good
let ceilingLatched = false;
let emMisses = 0;   // licznik kolejnych braków odczytu 3EM / consecutive 3EM read-miss counter

// Bezpieczne parsowanie / Safe parse: zwraca obiekt albo null (nigdy nie rzuca) /
// returns an object or null (never throws)
function safeParse(body) {
  if (body === null || body === undefined || body === "") return null;
  try { return JSON.parse(body); } catch (e) { return null; }
}

// ---------- Kolejka poleceń RPC (zapisy do grzałek) / RPC command queue (heater writes) ----------
let cmdQueue = [];
let cmdHead  = 0;
let cmdBusy  = false;
function enqueue(ip, method, params) { cmdQueue.push({ ip: ip, method: method, params: params }); pumpQueue(); }
function pumpQueue() {
  if (cmdBusy) return;
  if (cmdHead >= cmdQueue.length) { cmdQueue = []; cmdHead = 0; return; }
  cmdBusy = true;
  let c = cmdQueue[cmdHead];
  cmdHead++;
  let body = JSON.stringify({ id: 1, method: c.method, params: c.params });
  Shelly.call("HTTP.POST",
    { url: "http://" + c.ip + "/rpc", body: body, content_type: "application/json", timeout: 5 },
    function (res, err) { if (err !== 0) print("RPC blad ->", c.ip, c.method); cmdBusy = false; pumpQueue(); });
}

// ---------- Sterowanie stopniami grzałek / Heater stage control ----------
function applySteps(target) {
  if (target < 0) target = 0;
  if (target > STEPS.length) target = STEPS.length;
  for (let i = 0; i < STEPS.length; i++) enqueue(STEPS[i].ip, "Switch.Set", { id: STEPS[i].id, on: (i < target) });
  activeSteps = target;
}

// ---------- Logika grzałek (nadwyżka PV) / Heater logic (PV surplus) ----------
function updateHeaters() {
  // Ochrona bufora (lokalna) ma priorytet / Buffer protection (local) has priority
  let tb = temps.buffer;
  if (tb !== undefined) {
    if (!ceilingLatched && tb >= CFG.BUFFER_MAX) ceilingLatched = true;
    if (ceilingLatched && tb <= CFG.BUFFER_MAX - CFG.BUFFER_HYST) ceilingLatched = false;
  }
  if (ceilingLatched) { print("Bufor >= max (", tb, "C) -> grzalki OFF"); applySteps(0); return; }

  Shelly.call("HTTP.GET",
    { url: "http://" + CFG.EM_IP + "/rpc/EM.GetStatus?id=0", timeout: 5 },
    function (res, err) {
      let data = (err === 0 && res !== null && res.code === 200) ? safeParse(res.body) : null;

      // Brak poprawnego odczytu 3EM (błąd, timeout, puste/uszkodzone body) /
      // No valid 3EM reading (error, timeout, empty/broken body)
      if (data === null || data.total_act_power === undefined || data.total_act_power === null) {
        emMisses++;
        if (emMisses >= CFG.EM_MISS_LIMIT) {
          // Za dużo braków -> fail-safe / Too many misses -> fail-safe
          print("Brak odczytu 3EM x", emMisses, "-> grzalki OFF (fail-safe)");
          applySteps(0);
        } else {
          // Chwilowy brak -> trzymaj stan (re-assert odświeża watchdog) /
          // Transient miss -> hold state (re-assert refreshes the watchdog)
          print("Brak odczytu 3EM (", emMisses, "/", CFG.EM_MISS_LIMIT, ") - trzymam stan");
          applySteps(activeSteps);
        }
        return;
      }

      emMisses = 0;   // udany odczyt -> reset licznika / successful read -> reset counter
      let surplus = CFG.EXPORT_SIGN * data.total_act_power;
      let target = activeSteps;
      if (surplus >= CFG.STEP_W + CFG.POWER_MARGIN) target = activeSteps + 1;
      else if (surplus < -CFG.POWER_MARGIN)         target = activeSteps - Math.ceil((-surplus) / CFG.STEP_W);
      if (target < 0) target = 0;
      if (target > STEPS.length) target = STEPS.length;
      print("Nadwyzka:", surplus, "W | stopnie:", activeSteps, "->", target);
      applySteps(target);
    });
}

// ---------- Logika pompy obiegowej / Circulation pump logic ----------
function evaluatePump() {
  let tb = temps.buffer;
  if (tb === undefined) { print("Brak temp. bufora - pompa bez zmian"); return; }

  let cwu = [];
  if (temps.cwu1 !== undefined) cwu.push(temps.cwu1);
  if (temps.cwu2 !== undefined) cwu.push(temps.cwu2);
  if (temps.cwu3 !== undefined) cwu.push(temps.cwu3);
  if (cwu.length === 0) { print("Brak temp. CWU - pompa bez zmian"); return; }

  let minCwu = cwu[0], maxCwu = cwu[0];
  for (let i = 1; i < cwu.length; i++) { if (cwu[i] < minCwu) minCwu = cwu[i]; if (cwu[i] > maxCwu) maxCwu = cwu[i]; }
  let diff = tb - minCwu;

  Shelly.call("Switch.GetStatus", { id: CFG.PUMP_ID }, function (res, err) {
    let pumpOn = (res !== null) ? res.output : false;
    // Anti-scald / anti-scald
    if (CFG.CWU_MAX > 0 && maxCwu >= CFG.CWU_MAX) {
      if (pumpOn) { Shelly.call("Switch.Set", { id: CFG.PUMP_ID, on: false }); print("POMPA OFF (CWU >= max:", maxCwu, "C)"); }
      return;
    }
    if (!pumpOn && diff >= CFG.PUMP_ON_DIFF) {
      Shelly.call("Switch.Set", { id: CFG.PUMP_ID, on: true }); print("POMPA ON  | bufor:", tb, "minCWU:", minCwu, "diff:", diff);
    } else if (pumpOn && diff < CFG.PUMP_OFF_DIFF) {
      Shelly.call("Switch.Set", { id: CFG.PUMP_ID, on: false }); print("POMPA OFF | bufor:", tb, "minCWU:", minCwu, "diff:", diff);
    }
  });
}

// ---------- Odczyt czujników (po id; lokalnie lub z modułu) / Sensor reads (by id; local or module) ----------
function applyReading(s, tC) {
  if (tC === null || tC === undefined) { print("Brak odczytu", s.key, "- trzymam ostatnie"); return; }
  // 85.0 = błąd DS18B20 (CWU odrzucamy; bufor przepuszczamy - fail-safe) /
  // 85.0 = DS18B20 error (reject for DHW; let the buffer through - fail-safe)
  if (s.key !== "buffer" && tC === 85) { print(s.key, "= 85C (blad) - trzymam ostatnie"); return; }
  temps[s.key] = tC;
}

function readSensorChain(idx) {
  if (idx >= SENSORS.length) { evaluatePump(); updateHeaters(); return; }
  let s = SENSORS[idx];
  if (s.local) {
    Shelly.call("Temperature.GetStatus", { id: s.id }, function (r, e) {
      applyReading(s, (e === 0 && r !== null) ? r.tC : null);
      readSensorChain(idx + 1);
    });
  } else {
    Shelly.call("HTTP.GET",
      { url: "http://" + CFG.TEMPDEV_IP + "/rpc/Temperature.GetStatus?id=" + s.id, timeout: 5 },
      function (res, err) {
        let tC = null;
        if (err === 0 && res !== null && res.code === 200) {
          let d = safeParse(res.body);           // bez crasha na pustym/uszkodzonym body / no crash on empty/broken body
          if (d !== null && d.tC !== undefined) tC = d.tC;
        }
        applyReading(s, tC);
        readSensorChain(idx + 1);
      });
  }
}

// ---------- Watchdog grzałek / Heater watchdog ----------
function initWatchdog() {
  for (let i = 0; i < STEPS.length; i++) {
    enqueue(STEPS[i].ip, "Switch.SetConfig", { id: STEPS[i].id, config: { auto_off: true, auto_off_delay: CFG.AUTO_OFF_S } });
  }
}

// ---------- Pętla główna / Main loop ----------
function mainLoop() { readSensorChain(0); }

print("Start sterowania v5.1 (utwardzone pod flaky Wi-Fi). Cykl:", CFG.POLL_MS, "ms");
initWatchdog();
Timer.set(CFG.POLL_MS, true, mainLoop);
mainLoop();
