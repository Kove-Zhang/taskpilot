import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, ChildProcess } from 'node:child_process'

let tauriDriver: ChildProcess | undefined

export const config: WebdriverIO.Config = {
  specs: ['./test/e2e/**/*.ts'],
  maxInstances: 1,
  capabilities: [
    {
      'tauri:options': {
        application: './src-tauri/target/debug/app.exe',
      },
    },
  ],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },
  
  // ensure the rust project is built since we expect this binary to exist for the webdriver sessions
  onPrepare: () => spawnSync('cargo', ['build'], { cwd: './src-tauri', stdio: 'inherit' }),

  // ensure we are running `tauri-driver` before the session starts so that webdriverio can connect to it
  beforeSession: () => {
    tauriDriver = spawn(
      path.resolve(os.homedir(), '.cargo', 'bin', 'tauri-driver'),
      [],
      { stdio: [null, process.stdout, process.stderr] }
    )
  },

  // clean up the `tauri-driver` process we spawned at the start of the session
  afterSession: () => tauriDriver?.kill(),
}