"""Bounded scientific plot specifications and matplotlib SVG rendering."""

import io
from dataclasses import dataclass, field
from typing import Any, Literal
from pydantic import BaseModel, Field


@dataclass(frozen=True)
class PlotRenderStyle:
    color: str | None = None
    line_width: float | None = None
    scatter_size: float | None = None
    bar_width: float = 0.8
    rc: dict[str, Any] = field(default_factory=dict)


class Trace(BaseModel):
    """单条曲线/数据系列。

    x/y 数组每条上限 5000 点，label 长度 256。
    """

    x: list[float] = Field(..., max_length=5000)
    y: list[float] = Field(..., max_length=5000)
    label: str | None = Field(None, max_length=256)
    style: Literal["line", "scatter", "bar"] = "line"
    linestyle: Literal["-", "--", "-.", ":"] = "-"


class MatplotlibSpec(BaseModel):
    """通用科学图规范。

    plot_type: line/scatter/bar 由 trace 决定；spectrum 指定科学坐标轴方向惯例

    traces 上限 16 条；width/height/dpi 设硬边界防止画布巨大；
    title/xlabel/ylabel 单串上限 512。
    """

    plot_type: Literal["generic", "spectrum_xrd", "spectrum_nmr", "spectrum_ir"] = "generic"
    title: str | None = Field(None, max_length=512)
    xlabel: str | None = Field(None, max_length=512)
    ylabel: str | None = Field(None, max_length=512)
    traces: list[Trace] = Field(default_factory=list, max_length=16)
    xlim: tuple[float, float] | None = None
    ylim: tuple[float, float] | None = None
    grid: bool = True
    legend: bool = True
    width: float = Field(6.0, ge=2.0, le=24.0)  # inches
    height: float = Field(4.0, ge=2.0, le=24.0)
    dpi: int = Field(100, ge=72, le=300)


def render_plot(spec: MatplotlibSpec, *, style: PlotRenderStyle | None = None) -> dict[str, Any]:
    """Render trace data without changing process-wide backend/font policy."""
    import matplotlib
    import matplotlib.pyplot as plt

    style = style or PlotRenderStyle()
    with matplotlib.rc_context(rc=style.rc):
        figure, axes = plt.subplots(figsize=(spec.width, spec.height), dpi=spec.dpi)
        try:
            color = {"color": style.color} if style.color is not None else {}
            for trace in spec.traces:
                if trace.style == "line":
                    line = {"linewidth": style.line_width} if style.line_width is not None else {}
                    axes.plot(trace.x, trace.y, linestyle=trace.linestyle, label=trace.label, **color, **line)
                elif trace.style == "scatter":
                    size = {"s": style.scatter_size} if style.scatter_size is not None else {}
                    axes.scatter(trace.x, trace.y, label=trace.label, **color, **size)
                elif trace.style == "bar":
                    axes.bar(trace.x, trace.y, width=style.bar_width, label=trace.label, **color)
            if spec.title:
                axes.set_title(spec.title)
            if spec.xlabel:
                axes.set_xlabel(spec.xlabel)
            if spec.ylabel:
                axes.set_ylabel(spec.ylabel)
            if spec.xlim:
                axes.set_xlim(spec.xlim)
            if spec.ylim:
                axes.set_ylim(spec.ylim)
            if spec.plot_type in ("spectrum_nmr", "spectrum_ir"):
                axes.invert_xaxis()
            if spec.grid:
                axes.grid(True)
            if spec.legend and any(trace.label for trace in spec.traces):
                axes.legend()
            with io.StringIO() as output:
                figure.savefig(output, format="svg", bbox_inches="tight")
                return {"svg": output.getvalue(), "traceCount": len(spec.traces)}
        finally:
            # Render/validation exceptions must not retain pyplot figures.
            plt.close(figure)
