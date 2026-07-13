;(function () {
  if (!matchMedia("(display-mode: standalone)").matches) return

  var PROPERTY = "--app-viewport-height"

  function sync() {
    var height = (window.visualViewport && window.visualViewport.height) || window.innerHeight
    document.documentElement.style.setProperty(PROPERTY, height + "px")
  }

  sync()
  window.addEventListener("resize", sync)
  if (window.visualViewport) window.visualViewport.addEventListener("resize", sync)
})()
