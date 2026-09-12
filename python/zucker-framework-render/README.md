# Zucker Framework Render

Independent Python distribution for SchemDraw circuits, RDKit reactions and matplotlib scientific plots. No FastAPI application, product routes, deployment configuration, font installation, credentials or patent styling are included.

Public imports are defined in `zucker_framework_render.__all__`. Inputs use bounded Pydantic models. Renderers return dictionaries with `svg` and, where applicable, `elementCount` or `traceCount`. Validation/render failures propagate; an HTTP consumer decides status codes and localized error text. Matplotlib figures are closed on success and failure.

The host selects a matplotlib backend before importing the library when required (for example `matplotlib.use("Agg")` for a headless service). Font installation and `rcParams` font choice remain host policy. `CircuitRenderStyle`, `ReactionRenderStyle` and `PlotRenderStyle` provide explicit appearance configuration. The renderer does not load environment variables or allocate HTTP listeners.

`ReactionRenderStyle(monochrome=True)` opts into black-and-white atom symbols through RDKit's native palette. The default remains colored; the consumer decides its document presentation policy. This option requires updating the consumer's pinned source archive or distribution before deployment.

Version `0.1.0` has passed local source and editable-install acceptance; no release wheel has been published. Existing npm release automation does not publish this Python distribution. Consumers may bundle a hash-checked source archive from a reviewed committed revision into their Docker build and install it inside the image; this does not require PyPI publication. Alternatively, build and publish an immutable wheel through a separately authorized Python distribution channel. Record the source revision and hash, retain Apache-2.0 LICENSE and Framework NOTICE, and verify the resulting consumer image. Never overwrite a published version.

For separately authorized local development, an existing Python virtualenv can install this folder in editable mode. For a source-only run using already installed dependencies, put `python/zucker-framework-render/src` on `PYTHONPATH`. Neither path is a production artifact. The CNIPA service pins a source archive in its Docker build and retains its HTTP/presentation policy.

Local acceptance on 2026-09-11: `python -m unittest discover -s tests -v` passed all 6 tests, covering mixed-width label wrapping, IC cursor advance, real connected circuit SVG, input bounds, escaped reaction annotations, plot metadata and figure cleanup on failure. The editable distribution and its pinned dependencies passed dependency consistency checks on macOS arm64 / CPython 3.12.13.

CNIPA consumer acceptance additionally passed 9 API/policy tests and real development-server health plus 10 rendering requests through the public Node client. Four generated SVG samples were inspected in the browser, including CJK text and reversed NMR axes. CJK fonts were selected by the consumer; the library retains no host font policy. Release-wheel packaging, Linux image validation and publication remain separate stages.
