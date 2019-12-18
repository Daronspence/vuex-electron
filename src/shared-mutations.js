import { ipcMain, ipcRenderer } from "electron"

const IPC_EVENT_CONNECT = "vuex-mutations-connect"
const IPC_EVENT_REQUEST_STATE = "vuex-request-state"
const IPC_EVENT_MAIN_SEND_COMMIT = "ipc-event-main-send-commit";
const IPC_EVENT_MAIN_SEND_DISPATCH = "ipc-event-main-send-dispatch";
const IPC_EVENT_RENDERER_SEND_COMMIT = "ipc-event-renderer-send-commit";
const IPC_EVENT_RENDERER_SEND_DISPATCH = "ipc-event-renderer-send-dispatch";

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

  rendererProcessLogic() {
    // Connect renderer to main process
	this.options.ipcRenderer.send(IPC_EVENT_CONNECT, process.pid);

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

    // Commit override: perform locally, and send it to main process which will dispatch back to all other renderers
    this.store.commit = (type, payload) => {
	  this.options.ipcRenderer.send(IPC_EVENT_RENDERER_SEND_COMMIT, type, payload, process.pid);
	  return this.store.originalCommit(type, payload);
    }

    // Dispatch override: perform locally, and send it to main process which will dispatch back to all other renderers
    this.store.dispatch = (type, payload) => {
	  this.options.ipcRenderer.send(IPC_EVENT_RENDERER_SEND_DISPATCH, type, payload, process.pid);
	  return this.store.originalDispatch(type, payload);
    }
	
	// Commit received from main
	this.options.ipcRenderer.on(IPC_EVENT_MAIN_SEND_COMMIT, (event, type, payload) => {
		this.store.originalCommit(type, payload);
	});
	
	// Dispatch received from main
	this.options.ipcRenderer.on(IPC_EVENT_MAIN_SEND_DISPATCH, (event, type, payload) => {
		this.store.originalDispatch(type, payload);
	});
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
	this.options.ipcMain.on(IPC_EVENT_CONNECT, (event, pid) => {
      const win = event.sender
      connections[pid] = win

      // Remove connection when window is closed
      win.on("destroyed", () => {
        delete connections[pid]
      })
    })
    
    // Save original Vuex methods
    this.store.originalCommit = this.store.commit
    this.store.originalDispatch = this.store.dispatch
	
	
	// Override store.commit: perform commit locally, and send it to renderers excepted the original one if any
	this.store.commit = (type, payload, pid) => {
      Object.keys(connections).forEach((processId) => {
        if (parseInt(processId, 10) != pid) {
          connections[processId].send(IPC_EVENT_MAIN_SEND_COMMIT, type, payload)
        }
      })
      return this.store.originalCommit(type, payload)
	}
	
	// Override store.dispatch: perform dispatch locally, and send it to renderers excepted the original one if any
	this.store.dispatch = (type, payload, pid) => {
      Object.keys(connections).forEach((processId) => {
        if (parseInt(processId, 10) !== pid) {
          connections[processId].send(IPC_EVENT_MAIN_SEND_DISPATCH, type, payload)
        }
      })
      return this.store.originalDispatch(type, payload)
	}
	
	// Commit received from renderer
	this.options.ipcMain.on(IPC_EVENT_RENDERER_SEND_COMMIT, (event, type, payload, pid) => {
		this.store.commit(type, payload, pid);
	});
	
	// Dispatch received from renderer
	this.options.ipcMain.on(IPC_EVENT_RENDERER_SEND_DISPATCH, (event, type, payload, pid) => {
		this.store.dispatch(type, payload, pid);
	});
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
