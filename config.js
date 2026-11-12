// Where Paper Trail keeps its data. The repo is private; the site reaches it with
// a fine-grained token you paste into Settings on each device.
window.PT_CONFIG = {
  owner: "kpp91302",
  dataRepo: "paper-trail-data",
  branch: "main",
  // How many digest runs to load at first (about ten weeks). Older runs load on request.
  initialRuns: 90
};
