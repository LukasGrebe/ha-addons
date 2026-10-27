"""Run the Node tests of the Workbench's browser modules (workbench_js.test.mjs) when node is available."""

import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class WorkbenchJavaScript(unittest.TestCase):
    def test_browser_modules(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        result = subprocess.run([node, "--test", os.path.join(HERE, "workbench_js.test.mjs")],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
