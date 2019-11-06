import { ipcMain, ipcRenderer } from "electron"

const IPC_EVENT_CONNECT = "vuex-mutations-connect"
const IPC_EVENT_NOTIFY_MAIN = "vuex-mutations-notify-main"
const IPC_EVENT_NOTIFY_RENDERERS = "vuex-mutations-notify-renderers"
const IPC_EVENT_RENDERER_REQUEST_COMMIT = "vuex-renderer-request-commit"
const IPC_EVENT_REQUEST_STATE = "vuex-request-state"

class SharedMutations {
  constructor(options, store) {
    this.options = options
    this.store = store
  }

  loadOptions() {
    if (!this.options.type) this.options.type = process.type === "renderer" ? "renderer" : "main"
    if (!this.options.ipcMain) this.options.ipcMain = ipcMain
    if (!this.options.ipcRenderer) this.options.ipcRenderer = ipcRenderer
  }

  connect(payload) {
    this.options.ipcRenderer.send(IPC_EVENT_CONNECT, payload)
  }

  onConnect(handler) {
    this.options.ipcMain.on(IPC_EVENT_CONNECT, handler)
  }

  notifyMain(payload) {
    this.options.ipcRenderer.send(IPC_EVENT_NOTIFY_MAIN, payload)
  }

  onNotifyMain(handler) {
    this.options.ipcMain.on(IPC_EVENT_NOTIFY_MAIN, handler)
  }

  notifyRenderers(connections, payload) {
    Object.keys(connections).forEach((processId) => {
      connections[processId].send(IPC_EVENT_NOTIFY_RENDERERS, payload)
    })
  }

  onNotifyRenderers(handler) {
    this.options.ipcRenderer.on(IPC_EVENT_NOTIFY_RENDERERS, handler)
  }
  
  requestMain(payload) {
	this.options.ipcRenderer.send(IPC_EVENT_RENDERER_REQUEST_COMMIT, payload)
  }
  
  onRequestMain(handler) {
	this.options.ipcMain.on(IPC_EVENT_RENDERER_REQUEST_COMMIT, handler)
  }

  rendererProcessLogic() {
    // Connect renderer to main process
    this.connect()

    // Request the current store.state from the main process
    if (this.options.syncStateOnRendererCreation === true) {
      try {
        this.store.replaceState(this.options.ipcRenderer.sendSync(IPC_EVENT_REQUEST_STATE))
      } catch (error) {
        throw new Error(`[Vuex Electron] Couldn't synchronize the main store.state with a renderer: ${error}`)
      }
    }

    // Save original Vuex methods
    this.store.originalCommit = this.store.commit
    this.store.originalDispatch = this.store.dispatch

    // Forward commit to main process:
	// Ask the main process to do the commit itself, and then it will automatically
	// send it back to all renderer processes, including the requesting one
    this.store.commit = (type, payload) => {
	  this.requestMain({ type, payload })
    }

    // Forward dispatch to main process
    this.store.dispatch = (type, payload) => {
      this.notifyMain({ type, payload })
    }

    // Subscribe on changes from main process and apply them
    this.onNotifyRenderers((event, { type, payload }) => {
      this.store.originalCommit(type, payload)
    })
  }

  mainProcessLogic() {
    const connections = {}

    if (this.options.syncStateOnRendererCreation === true) {
      // handler to respond to renderer request for the vuex state
      this.options.ipcMain.on(IPC_EVENT_REQUEST_STATE, (event) => {
        event.returnValue = this.store.state
      })
    }

    // Save new connection
    this.onConnect((event) => {
      const win = event.sender
      const winId = win.id

      connections[winId] = win

      // Remove connection when window is closed
      win.on("destroyed", () => {
        delete connections[winId]
      })
    })

    // Subscribe on changes from renderer processes
    this.onNotifyMain((event, { type, payload }) => {
      this.store.dispatch(type, payload)
    })
	
	// Subscribe on commit requests from renderer processes
	this.onRequestMain((event, { type, payload }) => {
	  this.store.commit(type, payload)
	})

    // Subscribe on changes from Vuex store
    this.store.subscribe((mutation) => {
      const { type, payload } = mutation

      // Forward changes to renderer processes
      this.notifyRenderers(connections, { type, payload })
    })
  }

  activatePlugin() {
    switch (this.options.type) {
      case "renderer":
        this.rendererProcessLogic()
        break
      case "main":
        this.mainProcessLogic()
        break
      default:
        throw new Error(`[Vuex Electron] Type should be "renderer" or "main".`)
    }
  }
}

export default (options = {}) => (store) => {
  const sharedMutations = new SharedMutations(options, store)

  sharedMutations.loadOptions()
  sharedMutations.activatePlugin()
}
