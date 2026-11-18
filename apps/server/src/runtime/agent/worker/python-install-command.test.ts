import { describe, expect, it } from "vitest";
import { parsePythonInstallCommand } from "./python-install-command.js";

describe("Python installation command", () => {
  it("normalizes independent package arguments", () => {
    expect(
      parsePythonInstallCommand(
        ` python3 -m pip install 'My_Pkg[b,A]>=1,<2' "NumPy==2.2.0" numpy==2.2.0 `,
      ),
    ).toEqual(["my-pkg[a,b]>=1,<2", "numpy==2.2.0"]);
  });

  it.each([
    "python -m pip install",
    "pip install pkg",
    "python -m pip install -r requirements.txt",
    "python -m pip install --target=/tmp pkg",
    "python -m pip install git+https://example.com/pkg",
    "python -m pip install ./pkg.whl",
    'python -m pip install "pkg@example.com"',
    'python -m pip install "pkg==$(id)"',
    "python -m pip install pkg; pwd",
    "python -m pip install pkg > out",
    "python -m pip install pkg>out",
    "python -m pip install pkg.whl",
    "python -m pip install pkg | cat",
    "python -m pip install pkg && true",
    "python -m pip install pkg\n",
    "python -m pip install pkg # note",
    "INDEX=x python -m pip install pkg",
  ])("keeps %s outside the install flow", (command) => {
    expect(parsePythonInstallCommand(command)).toBeNull();
  });
});
