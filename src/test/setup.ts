import 'fake-indexeddb/auto'

// jsdom は scrollTo を実装していないので、画面遷移時のスクロールを無害化する
// （scripts/ のテストは Node の環境で動かすので、window が無い）
if (typeof window !== 'undefined') window.scrollTo = () => {}
