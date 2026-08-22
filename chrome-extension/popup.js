const out = document.getElementById('out');

document.getElementById('scan').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'tabs.scan' }, (response) => {
    out.textContent = JSON.stringify(response, null, 2);
  });
});
