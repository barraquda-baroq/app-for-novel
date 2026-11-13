// jsdom には PointerEvent がないので、指・マウスの区別（pointerType）を持てるものを用意する（長押しのテストで読み込む）
if (typeof window.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent {
    pointerType: string
    isPrimary: boolean
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerType = init.pointerType ?? 'mouse'
      this.isPrimary = init.isPrimary ?? true
    }
  }
  ;(window as unknown as { PointerEvent: typeof TestPointerEvent }).PointerEvent = TestPointerEvent
}

export {}
