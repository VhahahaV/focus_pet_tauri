# Focus Pet Hand

An offline WOFF2 subset of LXGW WenKai Regular for the Hand-drawn / Doodle theme's headings. Body text stays in the system sans-serif. The subset's internal family name is **Focus Pet Hand**, with a system-font fallback for characters outside the bundled UI vocabulary.

- Source: https://github.com/lxgw/LxgwWenKai/tree/main/fonts/TTF
- Original Git blob: `3e050e87caa5ce47f9c873079183e31f88fb8ce5`
- License and upstream copyright: `public/licenses/Focus-Pet-Hand-OFL.txt` (included in built app assets).
- Generated with FontTools from the source code's UI characters plus printable ASCII; no network request is made by the running application.

To regenerate after adding UI vocabulary, use a local copy of the upstream regular TTF and a Python environment with `fonttools[woff]`:

```sh
python scripts/subset-theme-font.py /path/to/LXGWWenKai-Regular.ttf
```
