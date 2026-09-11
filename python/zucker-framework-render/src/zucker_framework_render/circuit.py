"""Circuit models, mixed-width label layout and SchemDraw SVG rendering."""

import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator
import schemdraw
import schemdraw.elements as elm


@dataclass(frozen=True)
class CircuitRenderStyle:
    unit: float | None = None
    font_size: float | None = None
    color: str | None = None
    tall_element_spacing: float = 1.2


_ELEMENT_MAP: dict[str, Any] = {
    # ---- 无源基础元件 ----
    "resistor": elm.Resistor,
    "capacitor": elm.Capacitor,
    "capacitor_var": elm.CapacitorVar,
    "inductor": elm.Inductor,
    "inductor2": elm.Inductor2,
    "potentiometer": elm.Potentiometer,
    "thermistor": elm.Thermistor,
    "fuse": elm.Fuse,
    "crystal": elm.Crystal,
    "transformer": elm.Transformer,
    # ---- 二极管类 ----
    "diode": elm.Diode,
    "zener": elm.Zener,
    "schottky": elm.Schottky,
    "led": elm.LED,
    "photodiode": elm.Photodiode,
    "varactor": elm.Varactor,
    # ---- 有源器件 / IC ----
    "opamp": elm.Opamp,
    "ic": elm.Ic,
    "bjt_npn": elm.BjtNpn,
    "bjt_pnp": elm.BjtPnp,
    "jfet": elm.JFet,
    "nfet": elm.NFet,
    "pfet": elm.PFet,
    # ---- 电源 / 参考 ----
    "battery": elm.Battery,
    "voltage_source": elm.SourceV,
    "current_source": elm.SourceI,
    "source_sin": elm.SourceSin,
    "vdd": elm.Vdd,
    "vss": elm.Vss,
    "ground": elm.Ground,
    # ---- 开关 / 负载 / 其它 ----
    "switch": elm.Switch,
    "switch_spdt": elm.SwitchSpdt,
    "button": elm.Button,
    "lamp": elm.Lamp,
    "motor": elm.Motor,
    "speaker": elm.Speaker,
    "antenna": elm.Antenna,
    # ---- 连接 / 标注 ----
    "wire": elm.Line,
    "line": elm.Line,
    "dot": elm.Dot,
    "arrow": elm.Arrow,
    "gap": elm.Gap,
}


class CircuitElement(BaseModel):
    """单个电路元件 / 连线段。

    type: 元件类型
    label: 显示标签（如 "R1 1kΩ"，None 则不标）
    direction: 方向 'right' / 'left' / 'up' / 'down'，默认 right
    length: 长度（schemdraw unit），默认 3
    """

    # 合法类型直接由 _ELEMENT_MAP 派生：此前这里维护第二份 Literal 白名单，
    # 扩充元件时漏改会让请求被 Pydantic 422 拦掉（而不是走到渲染），排查费时。
    type: str
    label: str | None = None
    direction: Literal["right", "left", "up", "down"] = "right"
    length: float = 3.0

    @field_validator("type")
    @classmethod
    def _known_type(cls, v: str) -> str:
        if v not in _ELEMENT_MAP:
            raise ValueError(
                f"unknown element type: {v}; available types: {', '.join(sorted(_ELEMENT_MAP))}"
            )
        return v


class CircuitSpec(BaseModel):
    """电路图规范。

    title: 图标题（如 "Rectifier circuit"）
    elements: 元件序列，按链式追加（schemdraw 默认行为，每个元件接在前一个尾部）

    elements 数量硬上限 200，防 CPU/内存爆炸。
    """

    title: str | None = Field(None, max_length=512)
    elements: list[CircuitElement] = Field(default_factory=list, max_length=200)


# 纵向占位大的三端/多端器件：其后紧跟带标签元件时需补引线，否则标签压在符号上
_TALL_TYPES = frozenset({
    "nfet", "pfet", "jfet", "bjt_npn", "bjt_pnp", "opamp", "ic", "transformer",
})

# 纯连接/标注元件：本身不带可见标签体积，无需为其补引线
_CONNECTOR_TYPES = frozenset({"wire", "line", "dot", "ground", "gap", "vdd", "vss"})

# SchemDraw does not measure labels when laying out a chain. In particular,
# elm.Ic is a free-standing block: it draws a 2.5-unit rectangle but leaves the
# drawing cursor at the block's left edge. The following element is therefore
# placed on top of the IC unless the renderer advances the cursor explicitly.
#
# Keep each rendered line narrow enough to fit a normal 3-unit component. CJK
# glyphs are approximately twice the width of ASCII glyphs in the configured
# 12-point font, so East Asian display cells are a stable approximation without
# tying the layout to a font that may differ between local macOS and Linux.
_LABEL_MAX_DISPLAY_CELLS = 14
_LABEL_CELL_WIDTH_UNITS = 1 / 6
_LABEL_HORIZONTAL_PADDING_UNITS = 0.6
_IC_MIN_HEIGHT_UNITS = 2.5
_LABEL_LINE_HEIGHT_UNITS = 0.42
_LABEL_VERTICAL_PADDING_UNITS = 0.8
_REFERENCE_DESIGNATOR_RE = re.compile(r"^([A-Za-z]+\d+[A-Za-z0-9._-]*)\s+(.+)$")


def _display_width(text: str) -> int:
    """Return an approximate terminal-style width for mixed CJK/ASCII text."""
    return sum(
        2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
        for char in text
    )


def _balanced_wrap_line(text: str, max_width: int) -> list[str]:
    """Split one label line into visually balanced lines within max_width."""
    text = " ".join(text.split())
    if not text or _display_width(text) <= max_width:
        return [text] if text else []

    line_count = math.ceil(_display_width(text) / max_width)
    lines: list[str] = []
    remaining = text

    while line_count > 1:
        total_width = _display_width(remaining)
        target_width = total_width / line_count
        candidates: list[tuple[float, bool, int, str, str]] = []

        for index in range(1, len(remaining)):
            head = remaining[:index].rstrip()
            tail = remaining[index:].lstrip()
            if not head or not tail:
                continue

            head_width = _display_width(head)
            tail_width = _display_width(tail)
            if head_width > max_width or tail_width > (line_count - 1) * max_width:
                continue

            # Prefer an existing whitespace boundary when it is comparably
            # balanced. For Chinese labels, every character remains a valid
            # deterministic fallback boundary.
            whitespace_boundary = (
                remaining[index - 1].isspace() or remaining[index].isspace()
            )
            imbalance = abs(head_width - target_width)
            candidates.append(
                (imbalance, not whitespace_boundary, index, head, tail)
            )

        if not candidates:
            # A single glyph wider than max_width is not expected, but retaining
            # the text is safer than dropping it.
            lines.append(remaining)
            remaining = ""
            break

        _, _, _, head, tail = min(candidates)
        lines.append(head)
        remaining = tail
        line_count -= 1

    if remaining:
        lines.append(remaining)
    return lines


def _wrap_component_label(label: str) -> str:
    """Wrap long component labels while preserving explicit user line breaks."""
    wrapped: list[str] = []
    for raw_line in label.splitlines() or [label]:
        normalized = " ".join(raw_line.split())
        if not normalized:
            continue
        if _display_width(normalized) <= _LABEL_MAX_DISPLAY_CELLS:
            wrapped.append(normalized)
            continue

        # Technical reference designators (U1, S2, BT1, …) are clearer on a
        # dedicated line than when a Chinese device name is split mid-phrase.
        match = _REFERENCE_DESIGNATOR_RE.match(normalized)
        if match:
            wrapped.append(match.group(1))
            wrapped.extend(
                _balanced_wrap_line(match.group(2), _LABEL_MAX_DISPLAY_CELLS)
            )
        else:
            wrapped.extend(
                _balanced_wrap_line(normalized, _LABEL_MAX_DISPLAY_CELLS)
            )
    return "\n".join(wrapped)


def _label_width_units(label: str) -> float:
    widest_line = max((_display_width(line) for line in label.splitlines()), default=0)
    return widest_line * _LABEL_CELL_WIDTH_UNITS


def _move_in_direction(drawing: schemdraw.Drawing, direction: str, distance: float) -> None:
    """Advance Drawing.here for non-dropping block elements such as elm.Ic."""
    dx, dy = {
        "right": (distance, 0.0),
        "left": (-distance, 0.0),
        "up": (0.0, distance),
        "down": (0.0, -distance),
    }[direction]
    drawing.move(dx=dx, dy=dy)


def _add_circuit_element(drawing: schemdraw.Drawing, element: CircuitElement) -> Any:
    """Add one element with label-aware sizing and correct block cursor advance."""
    cls = _ELEMENT_MAP.get(element.type)
    if cls is None:
        raise ValueError(f"unknown element type: {element.type}")

    label = _wrap_component_label(element.label) if element.label else None
    manual_advance = 0.0

    if element.type == "ic":
        line_count = len(label.splitlines()) if label else 1
        width = max(
            2.5,
            element.length,
            _label_width_units(label or "") + _LABEL_HORIZONTAL_PADDING_UNITS,
        )
        height = max(
            _IC_MIN_HEIGHT_UNITS,
            line_count * _LABEL_LINE_HEIGHT_UNITS + _LABEL_VERTICAL_PADDING_UNITS,
        )
        instance = cls(size=(width, height))
        manual_advance = width
    else:
        instance = cls()

    instance = _apply_direction(instance, element.direction)
    if hasattr(instance, "length") and callable(instance.length):
        effective_length = element.length
        if label and element.direction in {"right", "left"}:
            effective_length = max(
                effective_length,
                _label_width_units(label) + _LABEL_HORIZONTAL_PADDING_UNITS,
            )
        try:
            instance = instance.length(effective_length)
        except TypeError:
            # 部分元件（如 Ground/Dot）没有 length 参数
            pass
    if label:
        instance = instance.label(label)
    drawing += instance

    if manual_advance:
        _move_in_direction(drawing, element.direction, manual_advance)
    return instance


def _apply_direction(instance: Any, direction: str) -> Any:
    """schemdraw 0.22 把方向方法移到了元件实例上（不再是 Drawing.right）。"""
    if direction == "right":
        return instance.right()
    if direction == "left":
        return instance.left()
    if direction == "up":
        return instance.up()
    if direction == "down":
        return instance.down()
    return instance


def render_circuit(spec: CircuitSpec, *, style: CircuitRenderStyle | None = None) -> dict[str, Any]:
    """Render validated circuit data; callers own HTTP/error presentation."""
    style = style or CircuitRenderStyle()
    with schemdraw.Drawing(show=False) as drawing:
        config = {}
        if style.unit is not None:
            config["unit"] = style.unit
        if style.font_size is not None:
            config["fontsize"] = style.font_size
        if style.color is not None:
            config["color"] = style.color
        drawing.config(**config)
        previous_is_tall = False
        for element in spec.elements:
            if previous_is_tall and element.type not in _CONNECTOR_TYPES:
                drawing += elm.Line().right().length(style.tall_element_spacing)
            previous_is_tall = element.type in _TALL_TYPES
            _add_circuit_element(drawing, element)
        raw = drawing.get_imagedata("svg")
        svg = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
    return {"svg": svg, "elementCount": len(spec.elements)}
