# Paper Trail

A personal reading log for research digests, served at https://kpp91302.github.io/paper-trail/.

Three scheduled Claude runs (a daily digest, a weekly optimization/ML digest and a weekly edge-of-stability digest) commit their picks to the private repository `kpp91302/paper-trail-data`. This site shows them with a one-paragraph summary and a worth-reading score out of 10, and records what you download, save, skip and rate (1–10). The runs read that record to learn your taste.

This repository holds only the site's code. No papers, ratings or tokens are stored here.

## Files

- `index.html`, `style.css`: page and styles
- `app.js`: loading from and saving to the data repository through the GitHub API
- `core.js`: pure data logic (merging runs, applying your actions, calibration), tested in `test/`
- `config.js`: which repository holds the data

## Connecting a device

Open the site, go to Settings, and paste a fine-grained GitHub token limited to `paper-trail-data` with Contents read and write. The token stays in that browser only.

## Tests

```
node test/core.test.js
```
