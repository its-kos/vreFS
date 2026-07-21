"""vreFS JupyterLab extension."""
from pathlib import Path

HERE = Path(__file__).parent.resolve()


def _jupyter_labextension_paths():
    return [{'src': str(HERE / 'labextension'), 'dest': 'NaaVRE-datalake-jupyterlab'}]