const tableBody = document.querySelector("#channelTable tbody");
const addBtn = document.getElementById("addBtn");
const saveBtn = document.getElementById("saveBtn");
let channels = {};

async function loadChannels() {
  const res = await fetch("/api/channels");
  channels = await res.json();
  renderTable();
}

function renderTable() {
  tableBody.innerHTML = "";
  Object.entries(channels).forEach(([name, data]) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input value="${name}" data-oldname="${name}" class="name"></td>
      <td><input value="${data.live}" class="live"></td>
      <td><input value="${data.cloud}" class="cloud"></td>
      <td><button class="del">🗑️</button></td>
    `;
    tableBody.appendChild(row);
  });
}

addBtn.onclick = () => {
  channels[`nuevo${Date.now()}`] = { live: "", cloud: "" };
  renderTable();
};

tableBody.addEventListener("click", (e) => {
  if (e.target.classList.contains("del")) {
    const name = e.target.closest("tr").querySelector(".name").value;
    delete channels[name];
    renderTable();
  }
});

saveBtn.onclick = async () => {
  const newData = {};
  document.querySelectorAll("#channelTable tbody tr").forEach((tr) => {
    const name = tr.querySelector(".name").value.trim();
    const live = tr.querySelector(".live").value.trim();
    const cloud = tr.querySelector(".cloud").value.trim();
    if (name) newData[name] = { live, cloud };
  });

  const res = await fetch("/api/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newData)
  });

  const msg = await res.json();
  alert(msg.message);
  loadChannels();
};

loadChannels();
