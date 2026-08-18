const out = document.getElementById('out');

document.getElementById('scan').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'tabs.scan' }, (response) => {
    out.textContent = JSON.stringify(response, null, 2);
  });
});

document.getElementById('pair').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'pair.start' }, (response) => {
    out.textContent = `配对码：${response.pairingCode}`;
  });
});
