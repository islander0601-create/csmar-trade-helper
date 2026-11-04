document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
  var tab = tabs && tabs[0];
  var el = document.getElementById('status');
  var url = (tab && tab.url) || '';
  if (url.indexOf('https://vetp.csmar.com') === 0) {
    el.textContent = '✅ 当前页面在支持范围内，右侧面板即已生效。';
    el.className = 'st ok';
  } else {
    el.textContent = '请先打开 https://vetp.csmar.com 的交易页面。';
    el.className = 'st no';
  }
}).catch(function () {
  document.getElementById('status').textContent = '请打开 vetp.csmar.com 使用。';
});
