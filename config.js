// Where Paper Trail keeps its data. The repo is private; the site reaches it with
// a fine-grained token you paste into Settings on each device.
window.PT_CONFIG = {
  owner: "kpp91302",
  dataRepo: "paper-trail-data",
  branch: "main",
  // Run files to load at first. Files older than 90 days are folded into
  // archive/ by the daily run, so this covers everything still current.
  initialRuns: 200
};
