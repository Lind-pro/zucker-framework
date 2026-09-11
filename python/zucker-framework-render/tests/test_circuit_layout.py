import unittest

import matplotlib
matplotlib.use("Agg")

import schemdraw
import schemdraw.elements as elm

from zucker_framework_render.circuit import (
    CircuitElement,
    CircuitSpec,
    _add_circuit_element,
    _display_width,
    _wrap_component_label,
    render_circuit,
    CircuitRenderStyle,
)


class SchemDrawLayoutTests(unittest.TestCase):
    def test_wraps_long_reference_labels_on_readable_boundaries(self) -> None:
        self.assertEqual(
            _wrap_component_label("S2 位移补偿位置传感器"),
            "S2\n位移补偿\n位置传感器",
        )
        self.assertEqual(
            _wrap_component_label("U3 通信模块蓝牙"),
            "U3\n通信模块蓝牙",
        )
        self.assertEqual(_wrap_component_label("U4 陀螺仪"), "U4 陀螺仪")

        for line in _wrap_component_label("S2 位移补偿位置传感器").splitlines():
            self.assertLessEqual(_display_width(line), 14)

    def test_ic_blocks_advance_before_the_next_chain_element(self) -> None:
        with schemdraw.Drawing(show=False) as drawing:
            first = _add_circuit_element(
                drawing,
                CircuitElement(type="ic", label="S1 对焦位置传感器"),
            )
            drawing += elm.Line().right().length(1.5)
            second = _add_circuit_element(
                drawing,
                CircuitElement(type="ic", label="S2 位移补偿位置传感器"),
            )

            first_center = first.absanchors["center"].x
            second_center = second.absanchors["center"].x

        # elm.Ic itself is non-dropping. The renderer must advance by the
        # three-unit block width before the explicit 1.5-unit connector.
        self.assertAlmostEqual(second_center - first_center, 4.5)
        self.assertAlmostEqual(drawing.here.x, 7.5)

    def test_connected_component_chain_renders_wrapped_labels(self) -> None:
        spec = CircuitSpec.model_validate(
            {
                "title": "图3 控制单元与各模块连接框图",
                "elements": [
                    {"type": "battery", "label": "BT1 3.7V", "direction": "up"},
                    {"type": "wire", "length": 1, "direction": "right"},
                    {"type": "ic", "label": "U2 电源管理PMU"},
                    {"type": "wire", "length": 1.5},
                    {"type": "dot"},
                    {"type": "wire", "length": 0.5},
                    {"type": "ic", "label": "U1 控制单元MCU"},
                    {"type": "wire", "length": 1.5},
                    {"type": "dot"},
                    {"type": "wire", "length": 0.5},
                    {"type": "ic", "label": "U3 通信模块蓝牙"},
                    {"type": "antenna", "label": "ANT1"},
                    {"type": "wire", "length": 1.5},
                    {"type": "ic", "label": "U4 陀螺仪"},
                    {"type": "wire", "length": 1.5},
                    {"type": "motor", "label": "M1 对焦马达"},
                    {"type": "wire", "length": 1.5},
                    {"type": "motor", "label": "M2 位移补偿致动器"},
                    {"type": "wire", "length": 1.5},
                    {"type": "ic", "label": "S1 对焦位置传感器"},
                    {"type": "wire", "length": 1.5},
                    {"type": "ic", "label": "S2 位移补偿位置传感器"},
                    {"type": "wire", "length": 1.5},
                    {"type": "ground", "direction": "down"},
                ],
            }
        )

        result = render_circuit(spec, style=CircuitRenderStyle(unit=3.5, font_size=12))

        self.assertEqual(result["elementCount"], 24)
        self.assertIn("<svg", result["svg"])
        # Matplotlib keeps each label as an SVG comment even when glyphs are
        # converted to paths. Newlines prove the long names were laid out on
        # separate lines instead of being painted over adjacent ICs.
        self.assertIn("<!-- S2 -->", result["svg"])
        self.assertIn("<!-- 位移补偿 -->", result["svg"])
        self.assertIn("<!-- 位置传感器 -->", result["svg"])


if __name__ == "__main__":
    unittest.main()
