// ──────────────────────────────────────────────────────────────────────────────
// HostPing → New Relic Event API
// - 1 event/host: eventType = "HostPing"
// - Rich metrics: rttAvgMs, rttMinMs, rttMaxMs, rttP95Ms, lossPct, ok/fail, severity
// - Dua cara input host: (A) CONFIG.hosts (array) atau (B) CONFIG.hostsText (teks "Nama,IP")
// Docs: Scripted API monitor ($http, $env) & Event API endpoints.
// ──────────────────────────────────────────────────────────────────────────────

var ping = require('net-ping');

// ======== CONFIG (EDIT DI SINI) ==============================================
var CONFIG = {
  // --- KREDENSIAL & ENDPOINT
  accountId: 'YOUR_ACCOUNT_ID',            // contoh: '4256160'
  insertKey: 'NRII-xxxxxxxxxxxxxxxxxxxx',  // Insert Key untuk Event API
  region: 'US',                            // 'US' atau 'EU'  (Event API region)  // docs: :contentReference[oaicite:2]{index=2}

  // --- MODE & LOGGING
  DRY_RUN: false,          // true = tidak kirim ke Event API (untuk uji coba)
  LOG_LEVEL: 'info',       // 'silent' | 'info' | 'debug'

  // --- PING SETTINGS
  perHostPings: 4,         // jumlah ping per host untuk statistik
  intervalMs: 200,         // jeda antar ping (ms)
  timeoutMs: 1000,         // timeout per ping (ms)
  retries: 0,              // retry internal per sample
  batchSize: 15,           // paralel per batch

  // --- SEVERITY THRESHOLDS
  thresholds: {
    rttWarnMs: 120,
    rttCritMs: 250,
    lossWarnPct: 10,
    lossCritPct: 30
  },
  failOnSeverity: 'WARN',  // 'OK' | 'WARN' | 'CRIT'

  // --- (A) HOSTS VIA ARRAY (direkomendasikan)
  hosts: [
    { host: 'Cloudflare DNS 1', ip: '1.1.1.1',     tag_env: 'prod', tag_group: 'dns' },
    { host: 'Google DNS 1',     ip: '8.8.8.8',     tag_env: 'prod', tag_group: 'dns' },
    { host: 'New Relic Lab',    ip: '192.168.2.22',tag_env: 'lab',  tag_group: 'server' },
    { host: 'Windows Server',   ip: '192.168.2.24',tag_env: 'prod', tag_group: 'server' },
    { host: 'Core GW',          ip: '10.0.0.1',    tag_env: 'corp', tag_group: 'gw' }
  ],

  // --- (B) HOSTS VIA TEKS SEDERHANA (opsional, kalau mau user non-technical isi sendiri)
  // Format: satu baris "Nama,IP". Baris kosong/#komentar diabaikan.
  hostsText: [
    // 'Cloudflare DNS 1,1.1.1.1',
    // 'Google DNS 1,8.8.8.8'
  ].join('\n')
};
// ============================================================================

// ── UTIL LOG ─────────────────────────────────────────────────────────────────
function log(level){ if (CONFIG.LOG_LEVEL === 'silent') return function(){}; 
  var order = {debug:3, info:2, silent:0}; var cur = order[CONFIG.LOG_LEVEL]||2;
  var need = level==='debug'?3:2; return need<=cur?console.log.bind(console):function(){};
}
var info = log('info'), debug = log('debug');
function maskKey(k){ return k ? (String(k).slice(0,6)+'…'+String(k).slice(-4)) : ''; }

// ── EVENT API ENDPOINT ───────────────────────────────────────────────────────
function eventEndpointBase(region) {
  return String(region||'US').toUpperCase() === 'EU'
    ? 'https://insights-collector.eu01.nr-data.net/v1/accounts/'
    : 'https://insights-collector.newrelic.com/v1/accounts/';
}
// Event API docs: send custom events → /v1/accounts/{accountId}/events  :contentReference[oaicite:3]{index=3}

// ── VALIDASI HOST INPUT ──────────────────────────────────────────────────────
var ipRegex = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
function parseHostsText(txt){
  var out=[]; if(!txt) return out;
  String(txt).replace(/\r/g,'').split('\n').forEach(function(line){
    var s=line.trim(); if(!s || s[0]==='#') return;
    var parts=s.split(','); if(parts.length<2) return;
    var name=String(parts[0]).trim(); var rest=parts.slice(1).join(',');
    var m=rest.match(ipRegex); if(name && m){ out.push({host:name, ip:m[0]}); }
  });
  return out;
}
function mergeHosts(arrayHosts, textHosts){
  var map={}, result=[];
  function push(h, why){
    if(!h) return;
    var name=(h.host||'').trim(), ip=(h.ip||'').trim();
    if(!name || !ipRegex.test(ip)){ info('Skip host invalid:', JSON.stringify(h), why||''); return; }
    var key=name+'|'+ip; if(map[key]){ debug('Skip duplicate:',key); return; }
    map[key]=true;
    var obj={ host:name, ip:ip };
    for(var k in h){ if(/^tag_/.test(k)) obj[k]=h[k]; }
    result.push(obj);
  }
  (arrayHosts||[]).forEach(function(h){ push(h,'(array)'); });
  (textHosts||[]).forEach(function(h){ push(h,'(text)'); });
  return result;
}

// ── PING HELPERS ────────────────────────────────────────────────────────────
function sleep(ms){ return new Promise(function(res){ setTimeout(res,ms); }); }
function classifyErr(err){
  var s=String((err&&(err.message||(err.toString&&err.toString())))||err||'');
  return /unreach|timed?out|ETIMEOUT|EHOSTUNREACH|EHOSTDOWN|rta\s*nan|lost\s*100%/i.test(s)?'Unreachable':'Down';
}
function statusCodeOf(st){ return st==='Up'?1:(st==='Unreachable'?-1:0); }
function percentile(arr,p){ if(!arr.length) return null;
  var a=arr.slice().sort(function(x,y){return x-y;});
  var idx=(p/100)*(a.length-1), lo=Math.floor(idx), hi=Math.ceil(idx);
  return lo===hi? a[lo] : a[lo]+(a[hi]-a[lo])*(idx-lo);
}
async function multiPing(session, ip, count, intervalMs){
  var samples=[], errors=[];
  for(var i=0;i<count;i++){
    /* eslint-disable no-await-in-loop */
    var r = await new Promise(function(resolve){
      session.pingHost(ip, function (error, target, sent, rcvd) {
        if (error) resolve({ok:false, err:String(error)});
        else resolve({ok:true, rtt: rcvd - sent});
      });
    });
    if(r.ok) samples.push(r.rtt); else errors.push(r.err);
    if(i<count-1 && intervalMs>0) await sleep(intervalMs);
  }
  return {samples:samples, errors:errors};
}
function deriveStats(samples){
  if(!samples.length) return {rttAvgMs:null,rttMinMs:null,rttMaxMs:null,rttP95Ms:null};
  var sum=samples.reduce(function(a,b){return a+b;},0);
  return {
    rttAvgMs: Math.round(sum/samples.length),
    rttMinMs: Math.min.apply(null,samples),
    rttMaxMs: Math.max.apply(null,samples),
    rttP95Ms: Math.round(percentile(samples,95))
  };
}
function deriveSeverity(rttP95, lossPct, th){
  var crit=(rttP95!=null && rttP95>=th.rttCritMs) || (lossPct!=null && lossPct>=th.lossCritPct);
  var warn=(rttP95!=null && rttP95>=th.rttWarnMs) || (lossPct!=null && lossPct>=th.lossWarnPct);
  return crit?'CRIT':(warn?'WARN':'OK');
}
function cmpSeverity(s){ return s==='CRIT'?3:(s==='WARN'?2:1); }

// ── HTTP POST EVENT API ─────────────────────────────────────────────────────
function postEvents(events, cb){
  if(CONFIG.DRY_RUN){
    info('[DRY_RUN] Events not sent. Example payload:', JSON.stringify(events.slice(0,Math.min(3,events.length)), null, 2));
    return cb();
  }
  var url = eventEndpointBase(CONFIG.region) + String(CONFIG.accountId) + '/events';
  $http.post(url, {
    headers: {'Api-Key': CONFIG.insertKey, 'Content-Type':'application/json'},
    body: JSON.stringify(events)
  }, function(err, resp, body){
    if (err) info('Event API error:', String(err));
    else info('Event API status:', resp && resp.statusCode, 'body:', body);
    cb();
  });
}

// ── MAIN ────────────────────────────────────────────────────────────────────
(async function main(){
  // Basic checks
  if(!CONFIG.accountId || !CONFIG.insertKey) throw new Error('CONFIG.accountId/insertKey wajib diisi.');
  info('Account:', CONFIG.accountId, 'Region:', CONFIG.region, 'InsertKey:', maskKey(CONFIG.insertKey));

  // Build host list from array + text
  var textHosts = parseHostsText(CONFIG.hostsText);
  var finalHosts = mergeHosts(CONFIG.hosts, textHosts);
  if(!finalHosts.length) throw new Error('Daftar host kosong (isi CONFIG.hosts atau CONFIG.hostsText).');
  info('Total hosts (valid & unique):', finalHosts.length);

  // Ping settings
  var session = ping.createSession({ retries: CONFIG.retries, timeout: CONFIG.timeoutMs });

  // Process in batches
  var allEvents=[], worstSeverity='OK';
  function chunk(arr,n){ var out=[],i=0; while(i<arr.length){ out.push(arr.slice(i,i+=n)); } return out; }
  var batches = chunk(finalHosts, CONFIG.batchSize);

  for(var b=0;b<batches.length;b++){
    info('Checking batch', (b+1)+'/'+batches.length, 'size', batches[b].length);
    var part = await Promise.all(batches[b].map(async function(h){
      var r = await multiPing(session, h.ip, CONFIG.perHostPings, CONFIG.intervalMs);
      var ok=r.samples.length, fail=r.errors.length, attempts=ok+fail;
      var loss = attempts ? Math.round((fail/attempts)*100) : null;
      var stats=deriveStats(r.samples);
      var status = ok>0 ? 'Up' : (fail>0 ? classifyErr(r.errors[r.errors.length-1]) : 'Down');
      var sev = deriveSeverity(stats.rttP95Ms, loss, CONFIG.thresholds);
      if(cmpSeverity(sev)>cmpSeverity(worstSeverity)) worstSeverity=sev;

      var evt = {
        eventType: 'HostPing',
        host: h.host, ip: h.ip,
        status: status, statusCode: statusCodeOf(status),
        lossPct: loss, okCount: ok, failCount: fail, attemptCount: attempts,
        rttAvgMs: stats.rttAvgMs, rttMinMs: stats.rttMinMs, rttMaxMs: stats.rttMaxMs, rttP95Ms: stats.rttP95Ms,
        severity: sev,
        monitorName: $env && $env.MONITOR_NAME,
        location: $env && $env.LOCATION,
        runId: $env && $env.RUN_ID,
        timestampMs: Date.now()
      };
      for(var k in h){ if(/^tag_/.test(k)) evt[k]=h[k]; }
      if(fail>0 && r.errors.length){
        var lastErr=String(r.errors[r.errors.length-1]); evt.lastError = lastErr.length>500? lastErr.slice(0,500): lastErr;
      }
      debug('→', h.host, h.ip, 'status=', status, 'p95=', stats.rttP95Ms, 'loss=', loss, 'sev=', sev);
      return evt;
    }));
    allEvents = allEvents.concat(part);
  }

  session.close();

  // Lightweight attributes to SyntheticCheck (optional)
  try{ $util.insights.setAttribute('hp_sent', allEvents.length);
       $util.insights.setAttribute('hp_worst_sev', worstSeverity); } catch(e){}

  // POST
  postEvents(allEvents, function(){
    if(cmpSeverity(worstSeverity) >= cmpSeverity(CONFIG.failOnSeverity)){
      throw new Error('[HostPing] worst severity='+worstSeverity+' (policy='+CONFIG.failOnSeverity+')');
    } else {
      info('All done. events=', allEvents.length, 'worstSeverity=', worstSeverity);
    }
  });
})();
