(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))o(n);new MutationObserver(n=>{for(const a of n)if(a.type==="childList")for(const p of a.addedNodes)p.tagName==="LINK"&&p.rel==="modulepreload"&&o(p)}).observe(document,{childList:!0,subtree:!0});function i(n){const a={};return n.integrity&&(a.integrity=n.integrity),n.referrerPolicy&&(a.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?a.credentials="include":n.crossOrigin==="anonymous"?a.credentials="omit":a.credentials="same-origin",a}function o(n){if(n.ep)return;n.ep=!0;const a=i(n);fetch(n.href,a)}})();async function r(e,t={},i){return window.__TAURI_INTERNALS__.invoke(e,t,i)}let l=[],v={},d="claude",s="",u=null,g=new Date;const b=document.querySelector("#app");async function E(){await m(),c(),setInterval(()=>{g=new Date,h()},6e4)}async function m(){try{l=await r("get_conversations"),v=await r("get_platforms"),d=await r("get_active_platform")}catch(e){console.error("Failed to load data:",e)}}function S(e){const t=new Date(e*1e3),i=Math.floor(Math.max(0,g.getTime()-t.getTime())/(1e3*60));if(i<1)return"<1m";if(i<60)return`${i}m`;const o=Math.floor(i/60);return o<24?`${o}hr`:`${Math.floor(o/24)}d`}function h(){return l.length===0?'<div class="empty-state">No conversations yet</div>':l.map(e=>{const t=e.id===s,i=u===e.id,o=e.messages.length,n=v[e.platform]?.name||e.platform,a=S(e.updated_at);return`
      <div class="conversation-item ${t?"active":""}" data-id="${e.id}">
        ${t?'<div class="active-indicator"></div>':""}
        <div class="conversation-main" ${i?"":`onclick="selectConversation('${e.id}')"`}>
          <div class="conversation-header">
            <div class="conversation-title">${i?"":f(e.title)}</div>
            ${a?`<span class="compact-time">${a}</span>`:""}
          </div>
          <div class="conversation-meta">
            <span class="platform-tag">${n}</span>
            ${o>0?`<span class="message-count">${o}</span>`:""}
          </div>
        </div>
        ${i?`
          <div class="edit-container">
            <input type="text" 
                   class="edit-input" 
                   id="edit-input-${e.id}"
                   value="${f(e.title)}"
                   onkeydown="handleEditKeydown(event, '${e.id}')"
            />
            <button class="edit-action-btn save" onclick="saveEdit('${e.id}')">✓</button>
            <button class="edit-action-btn cancel" onclick="cancelEdit()">✕</button>
          </div>
        `:`
          <div class="action-buttons">
            <button class="action-btn edit" onclick="startEdit('${e.id}')" title="Edit">✎</button>
            <button class="action-btn delete" onclick="deleteConversation('${e.id}')" title="Delete">🗑</button>
          </div>
        `}
      </div>
    `}).join("")}function c(){b.innerHTML=`
    <div class="app-container">
      <div class="sidebar">
        <div class="sidebar-header">
          <h1>AI CLI Manager</h1>
          <button class="new-chat-btn" id="new-chat-btn">+ New Chat</button>
        </div>
        <div class="platform-selector">
          <select id="platform-select">
            ${Object.entries(v).map(([e,t])=>`<option value="${e}" ${e===d?"selected":""}>${t.name}</option>`).join("")}
          </select>
        </div>
        <div class="conversation-list" id="conversation-list">
          ${h()}
        </div>
      </div>
      <div class="main-content">
        ${s?C():L()}
        <div class="input-area">
          <textarea id="message-input" placeholder="Enter your message..."></textarea>
          <button class="send-btn" id="send-btn">Send</button>
        </div>
      </div>
    </div>
  `,_()}function _(){document.querySelector("#new-chat-btn")?.addEventListener("click",T),document.querySelector("#platform-select")?.addEventListener("change",I);const e=document.querySelector("#message-input");e&&e.addEventListener("keydown",q),document.querySelector("#send-btn")?.addEventListener("click",w),u&&setTimeout(()=>{const t=document.querySelector(`#edit-input-${u}`);t&&(t.focus(),t.select())},50)}function C(){const e=l.find(t=>t.id===s);return e?`
    <div class="chat-header">
      <h2>${f(e.title)}</h2>
      <span class="platform-badge">${v[e.platform]?.name||e.platform}</span>
    </div>
    <div class="message-list" id="message-list">
      ${e.messages.map(t=>`
        <div class="message ${t.role}">
          <div class="message-avatar">${t.role==="user"?"You":"AI"}</div>
          <div class="message-content">
            <pre>${f(t.content)}</pre>
            <div class="message-time">${D(t.timestamp)}</div>
          </div>
        </div>
      `).join("")}
    </div>
  `:""}function L(){return`
    <div class="empty-chat">
      <div class="empty-icon">💬</div>
      <h2>Start a New Conversation</h2>
      <p>Select a platform from the dropdown and start chatting with your AI CLI</p>
    </div>
  `}function T(){s="",c(),setTimeout(()=>{const e=document.querySelector("#message-input");e&&e.focus()},100)}async function I(e){const t=e.target;t&&t.value!==d&&(d=t.value,await r("set_active_platform",{platform_id:d}))}async function w(){const e=document.querySelector("#message-input"),t=document.querySelector("#send-btn");if(!e||!e.value.trim())return;const i=e.value.trim();e.value="",t&&(t.disabled=!0);try{const o=await r("execute_prompt",{prompt:i});s||(s=await r("create_conversation",{platform:d})),await r("send_message",{conversation_id:s,content:i+`

---

`+o}),await m(),c(),setTimeout(()=>{const n=document.querySelector("#message-list");n&&(n.scrollTop=n.scrollHeight)},100)}catch(o){console.error("Failed to send message:",o),alert("Failed to send message: "+String(o))}finally{t&&(t.disabled=!1)}}function q(e){e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),w())}function D(e){return new Date(e*1e3).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}function f(e){const t=document.createElement("div");return t.textContent=e,t.innerHTML}function M(e){s=e,c(),setTimeout(()=>{const t=document.querySelector("#message-list");t&&(t.scrollTop=t.scrollHeight)},100)}async function k(e){confirm("Are you sure you want to delete this conversation?")&&(await r("delete_conversation",{conversation_id:e}),await m(),s===e&&(s=l.length>0?l[0].id:""),c())}function N(e){u=e,c()}function y(){u=null,c()}async function $(e){const t=document.querySelector(`#edit-input-${e}`);if(!t)return;const i=t.value.trim();if(!i){y();return}try{await r("update_conversation_title",{conversation_id:e,title:i}),await m(),u=null,c()}catch(o){console.error("Failed to update title:",o),alert("Failed to update title: "+String(o))}}function A(e,t){e.key==="Enter"?(e.preventDefault(),$(t)):e.key==="Escape"&&(e.preventDefault(),y())}window.selectConversation=M;window.deleteConversation=k;window.startEdit=N;window.cancelEdit=y;window.saveEdit=$;window.handleEditKeydown=A;E();
