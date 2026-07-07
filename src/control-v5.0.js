// =====================================================================
//  Sterowanie grzałkami (nadwyżka PV) + pompa obiegowa (różnicówka)
//  PV-surplus heater control + differential circulation pump
//  ---------------------------------------------------------------------
//  PL: Skrypt uruchamiany na SHELLY 1PM GEN4 (MASTER)
//      - pompa obiegowa  -> lokalny przekaźnik (Switch:0)
//      - czujniki temp.  -> 4 szt. na 2x 1PM Gen4 + Add-on, podział 2+2:
//            * MASTER (lokalnie): BUFOR + CWU1
//            * MODUŁ (RPC):       CWU2 + CWU3
//      - nadwyżka mocy   -> Shelly Pro 3EM (RPC)
//      - grzałki         -> 3x Shelly Pro 3 (RPC), 9 stopni po 2 kW
//      Odczyt czujników po ID komponentu (nowszy FW nie wystawia adresu 1-Wire).
//
//  EN: Runs on SHELLY 1PM GEN4 (MASTER)
//      - circulation pump -> local relay (Switch:0)
//      - temp sensors     -> 4 across 2x 1PM Gen4 + Add-on, split 2+2:
//            * MASTER (local): BUFFER + DHW1
//            * MODULE (RPC):   DHW2 + DHW3
//      - power surplus    -> Shelly Pro 3EM (RPC)
//      - heaters          -> 3x Shelly Pro 3 (RPC), 9 stages of 2 kW
//      Sensors read by component ID (newer FW no longer exposes the 1-Wire address).
//
//  Uwaga / Note: komunikaty print() są po polsku (odwołuje się do nich instrukcja) /
//                print() log messages are in Polish (the deployment guide refers to them).
//
//  Wersja / Version: 5.0
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

// Definicja czujników: gdzie są i pod jakim id / Sensor map: where each lives and its id
//   local:true  -> MASTER (odczyt lokalny / local read)
//   local:false -> MODUŁ  (odczyt po RPC z CFG.TEMPDEV_IP / read over RPC from CFG.TEMPDEV_IP)
//   id -> numer komponentu temperature, zwykle 100/101 per urządzenie /
//         temperature component id, usually 100/101 per device
//   Ustal id podgrzewając czujnik i patrząc, gdzie skoczyło tC /
//   Find the id by warming a sensor and seeing which tC rises.
let SENSORS = [
  { key: "buffer", local: true,  id: 100 },  // bufor / buffer  (MASTER)
  { key: "cwu1",   local: true,  id: 101 },  // CWU1 / DHW1      (MASTER)
  { key: "cwu2",   local: false, id: 100 },  // CWU2 / DHW2      (MODUŁ / MODULE)
  { key: "cwu3",   local: false, id: 101 }   // CWU3 / DHW3      (MODUŁ / MODULE)
];

// Mapa stopni grzałek -> fizyczne styki / Heater stages -> physical contacts
let STEPS = [
  { ip: CFG.HEATER1_IP, id: 0 }, { ip: CFG.HEATER1_IP, id: 1 }, { ip: CFG.HEATER1_IP, id: 2 },
  { ip: CFG.HEATER2_IP, id: 0 }, { ip: CFG.HEATER2_IP, id: 1 }, { ip: CFG.HEATER2_IP, id: 2 },
  { ip: CFG.HEATER3_IP, id: 0 }, { ip: CFG.HEATER3_IP, id: 1 }, { ip: CFG.HEATER3_IP, id: 2 }
];

let activeSteps = 0;
let temps = { buffer: undefined, cwu1: undefined, cwu2: undefined, cwu3: undefined }; // last-good
let ceilingLatched = false;

// ---------- Kolejka poleceń RPC (zapisy do grzałek) / RPC command queue (heater writes) ----------
// Polecenia idą sekwencyjnie, by nie przekroczyć limitu równoległych HTTP w skrypcie.
// Commands are sent one at a time to stay within the script's concurrent-HTTP limit.
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
// Re-assert ON dla aktywnych (odświeża auto-off = watchdog), OFF dla reszty.
// Re-assert ON for active stages (refreshes auto-off = watchdog), OFF for the rest.
function applySteps(target) {
  if (target < 0) target = 0;
  if (target > STEPS.length) target = STEPS.length;
  for (let i = 0; i < STEPS.length; i++) enqueue(STEPS[i].ip, "Switch.Set", { id: STEPS[i].id, on: (i < target) });
  activeSteps = target;
}

// ---------- Logika grzałek (nadwyżka PV) / Heater logic (PV surplus) ----------
function updateHeaters() {
  // Ochrona bufora ma bezwzględny priorytet / Buffer protection has absolute priority
  let tb = temps.buffer;
  if (tb !== undefined) {
    if (!ceilingLatched && tb >= CFG.BUFFER_MAX) ceilingLatched = true;
    if (ceilingLatched && tb <= CFG.BUFFER_MAX - CFG.BUFFER_HYST) ceilingLatched = false;
  }
  if (ceilingLatched) { print("Bufor >= max (", tb, "C) -> grzalki OFF"); applySteps(0); return; }

  Shelly.call("HTTP.GET",
    { url: "http://" + CFG.EM_IP + "/rpc/EM.GetStatus?id=0", timeout: 5 },
    function (res, err) {
      if (err !== 0 || res === null || res.code !== 200) {
        // Brak pomiaru -> fail-safe: grzałki OFF / No reading -> fail-safe: heaters OFF
        print("Brak odczytu 3EM -> grzalki OFF (fail-safe)"); applySteps(0); return;
      }
      let surplus = CFG.EXPORT_SIGN * JSON.parse(res.body).total_act_power;
      // Dokładamy 1 stopień przy zapasie, przy poborze zdejmujemy tyle, ile trzeba /
      // Add one stage when there is headroom; on import shed as many as needed.
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

  // Najzimniejsze CWU = największy potencjał oddania ciepła /
  // Coldest DHW = greatest potential to absorb heat
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
    // Anti-scald: nie ładuj CWU powyżej limitu / do not load DHW above the limit
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
  // 85.0 = błąd DS18B20. Dla CWU odrzucamy; bufor przepuszczamy (fail-safe, BUFFER_MAX < 85).
  // 85.0 = DS18B20 error value. Reject for DHW; let the buffer through (fail-safe, BUFFER_MAX < 85).
  if (s.key !== "buffer" && tC === 85) { print(s.key, "= 85C (blad) - trzymam ostatnie"); return; }
  temps[s.key] = tC;
}

function readSensorChain(idx) {
  if (idx >= SENSORS.length) { evaluatePump(); updateHeaters(); return; }
  let s = SENSORS[idx];
  if (s.local) {
    // Odczyt lokalny na masterze / Local read on the master
    Shelly.call("Temperature.GetStatus", { id: s.id }, function (r, e) {
      applyReading(s, (e === 0 && r !== null) ? r.tC : null);
      readSensorChain(idx + 1);
    });
  } else {
    // Odczyt zdalny z modułu / Remote read from the module
    Shelly.call("HTTP.GET",
      { url: "http://" + CFG.TEMPDEV_IP + "/rpc/Temperature.GetStatus?id=" + s.id, timeout: 5 },
      function (res, err) {
        let tC = null;
        if (err === 0 && res !== null && res.code === 200) tC = JSON.parse(res.body).tC;
        applyReading(s, tC);
        readSensorChain(idx + 1);
      });
  }
}

// ---------- Watchdog grzałek / Heater watchdog ----------
// Każdy stopień sam zgaśnie po AUTO_OFF_S ciszy mastera / each stage self-clears after AUTO_OFF_S of master silence
function initWatchdog() {
  for (let i = 0; i < STEPS.length; i++) {
    enqueue(STEPS[i].ip, "Switch.SetConfig", { id: STEPS[i].id, config: { auto_off: true, auto_off_delay: CFG.AUTO_OFF_S } });
  }
}

// ---------- Pętla główna / Main loop ----------
function mainLoop() { readSensorChain(0); }

print("Start sterowania v5 (4 czujniki 2+2, odczyt po id). Cykl:", CFG.POLL_MS, "ms");
initWatchdog();
Timer.set(CFG.POLL_MS, true, mainLoop);
mainLoop();
