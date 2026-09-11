# Deterministic SVG rendering

- `requestSvgRender` posts structured JSON to an explicit endpoint and requires a nonempty `svg` response field. `SvgRenderRequestError.stage` distinguishes transport, HTTP and invalid response failures. HTTP detail is limited to 300 characters; callers own localization, endpoint/URL policy and request budgets. Abort errors retain their identity.
- `requestKrokiSvg` posts plain diagram source to an explicit Kroki endpoint with the same error/cancellation contract. It returns raw SVG text and elapsed time.
- `renderSmilesSvg` loads the optional RDKit WASM peer only when used. It releases the molecule after success, invalid input or render failure. `RdkitLoadError` and `InvalidSmilesError` distinguish configuration and input failures. An already initialized module can be supplied through `RdkitSvgModule`.
- `renderVegaLiteSvg` lazily loads optional Vega/Vega-Lite peers, compiles a spec and finalizes the headless view after extraction. `VegaSvgModules` permits reuse of already loaded modules. Renderer failures retain their cause in `VegaSvgRenderError`.

These APIs contain no product model selection, prompt generation, environment reads, route defaults or persistent task state. Application-specific metadata assembly is a consumer concern. Optional rendering peers remain external to the package and are not eagerly loaded by root imports. No runtime tests, actual SVG rendering, builds or publication were executed during the source-only migration.

Python circuit/reaction/scientific-plot renderers have a separate distribution at `python/zucker-framework-render`; Python code is not bundled into this TypeScript package.
