const bAPI = typeof browser !== 'undefined' ? browser : chrome;

bAPI.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'openTab') {
    bAPI.tabs.create({ url: msg.url });
  }
});
