// State shared by the whole page. Each tab also keeps its own form state in its own module.

export const app = {
  me: null,        // signed-in user: { id, role }
  server: null,    // racking data as last loaded from or saved to the server (includes machines and version)
  data: null,      // the copy being edited: { parts, sections }. Only admins change it before saving.
  dirty: false,    // data has unsaved edits
  saving: false,
  saveErr: '',
  newer: null,     // { version, savedAt, savedBy } when someone else saved a newer version
};

export const ui = {
  tab: 'hq',       // a section key, or 'receive', 'transfer', 'machines', 'master', 'admin'
  rows: {},        // the row picked in each section: { hq: 2 }
  armed: null,     // a remove button waiting for its second click: 'row' or a part key
  account: false,  // the change-passkey panel is open
};

export const MACHINES = ['EMK', 'EMLK', 'P4', 'L5'];
export const MAX_PALLETS = 2; // most pallets one transfer may combine (the server checks the same)
export const ROLE_NAMES = { viewer: 'Viewer', supervisor: 'Supervisor', handler: 'Material Handler', shipping: 'Shipping and Receiving', admin: 'Admin' };
