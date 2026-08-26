const $ = id => document.getElementById(id);
async function refresh(){render(await window.fragbotBridge.getState());}
function render(state){
  $("cloudDot").classList.toggle("ok",state.cloudConnected);
  $("cloudText").textContent=state.cloudConnected?"FRAGBOT Cloud — Connected":"FRAGBOT Cloud — Disconnected";
  $("meldDot").classList.toggle("ok",state.meld.connected);
  $("meldText").textContent=state.meld.connected?"Meld Studio — Connected":"Meld Studio — Disconnected";
  $("pairState").textContent=state.paired?"Paired":"Not paired";
  $("account").textContent=state.account?.displayName||state.account?.channelId||"—";
  $("device").textContent=`${state.deviceName||"PC"} (${state.deviceId||"—"})`;
  $("pairPanel").style.display=state.paired?"none":"block";
  $("unpair").disabled=!state.paired; $("cloudReconnect").disabled=!state.paired;
  $("apiVersion").textContent=state.meld.apiVersion??"—";
  $("currentScene").textContent=state.meld.currentScene?.name||"—";
  $("streaming").textContent=state.meld.isStreaming?"Yes":"No";
  $("recording").textContent=state.meld.isRecording?"Yes":"No";
  $("scenes").textContent=state.resources?.scenes?.length??0;
  $("layers").textContent=state.resources?.layers?.length??0;
  $("tracks").textContent=state.resources?.tracks?.length??0;
  $("effects").textContent=state.resources?.effects?.length??0;
  $("autoStart").checked=Boolean(state.autoStart); $("version").textContent=`FRAGBOT Bridge v${state.version}`;
}
$("pairBtn").addEventListener("click",async()=>{ $("pairError").textContent=""; $("pairBtn").disabled=true; const r=await window.fragbotBridge.pair($("pairCode").value); $("pairBtn").disabled=false; if(!r.ok) $("pairError").textContent=r.error?.message||"Pairing failed."; else{$("pairCode").value="";await refresh();}});
$("unpair").addEventListener("click",async()=>{await window.fragbotBridge.unpair();await refresh();});
$("meldReconnect").addEventListener("click",()=>window.fragbotBridge.reconnectMeld());
$("cloudReconnect").addEventListener("click",()=>window.fragbotBridge.reconnectCloud());
$("dashboard").addEventListener("click",()=>window.fragbotBridge.openDashboard());
$("autoStart").addEventListener("change",async e=>{await window.fragbotBridge.setAutoStart(e.target.checked);await refresh();});
window.fragbotBridge.onState(render);
window.fragbotBridge.onLog(line=>{const logs=$("logs");logs.textContent+="\n"+line;if(logs.textContent.length>30000)logs.textContent=logs.textContent.slice(-20000);logs.scrollTop=logs.scrollHeight;});
refresh();
