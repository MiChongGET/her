"""Generate a constant, nonprivate one-page text-and-chart PDF; Python stdlib only."""
from pathlib import Path
stream = b'BT /F1 20 Tf 40 740 Td (CHART_MARKER_741) Tj ET\n1 0 0 rg 100 100 100 200 re f\n0 0 1 rg 250 100 100 350 re f\n0 0 0 RG 40 100 m 500 100 l S\n'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream']
data = b'%PDF-1.4\n'; offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(data)); data += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
xref = len(data)
data += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
data += f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
Path(__file__).with_name('chart.pdf').write_bytes(data)
