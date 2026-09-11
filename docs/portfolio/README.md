# Portfolio exports

These images present the real OLED Studio simulator UI and its native 960×376
frame output without a laptop mockup, perspective distortion, or fabricated
hardware state.

| File | Size | Intended use |
| --- | ---: | --- |
| `kmong-service-cover-1200x900.png` | 1200×900 | Kmong service thumbnail (4:3) |
| `kmong-portfolio-cover-1200x1200.png` | 1200×1200 | Kmong portfolio cover (1:1) |
| `kmong-web-control-1600x1000.png` | 1600×1000 | Portfolio detail: browser control surface |
| `kmong-panel-output-1600x1000.png` | 1600×1000 | Portfolio detail: native panel output |

Recommended upload order: square cover, web control, then panel output. The UI
remains labelled `SIMULATOR` wherever no physical device is connected.

`index.html` and `portfolio.css` are the reproducible source frames. Serve the
repository root over HTTP before capturing them so the local fonts and source
screenshots load correctly.
