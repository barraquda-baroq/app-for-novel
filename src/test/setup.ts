import 'fake-indexeddb/auto'

// jsdom は scrollTo を実装していないので、画面遷移時のスクロールを無害化する
window.scrollTo = () => {}
