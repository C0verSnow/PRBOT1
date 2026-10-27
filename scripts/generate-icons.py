"""Original PRBOT vector mark + portable PNG/ICO/ICNS assets. Python stdlib only.
Asset preparation, not application compilation. Run from the repository root.
"""
from pathlib import Path
import math
import struct
import zlib

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<rect x="32" y="32" width="960" height="960" rx="224" fill="#253a32"/>
<path d="M300 326L460 486L300 646M514 646H702" fill="none" stroke="#e6f2da" stroke-width="70" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M700 304V430" stroke="#a7d58d" stroke-width="40" stroke-linecap="round"/>
<circle cx="700" cy="292" r="55" fill="#a7d58d"/>
</svg>\n'''
Path('public/prbot.svg').write_text(SVG)

def segment(x, y, ax, ay, bx, by):
    dx, dy = bx-ax, by-ay
    t = max(0, min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-ax-t*dx, y-ay-t*dy)

def png(size):
    rows = bytearray()
    scale = 1024 / size
    for py in range(size):
        rows.append(0)
        y = (py+.5)*scale
        for px in range(size):
            x = (px+.5)*scale
            qx, qy = abs(x-512)-256, abs(y-512)-256
            dist = math.hypot(max(qx,0), max(qy,0)) + min(max(qx,qy),0)-224
            alpha = max(0, min(1, .5-dist/scale))
            rgb = [37,58,50]
            stroke = min(segment(x,y,300,326,460,486), segment(x,y,460,486,300,646), segment(x,y,514,646,702,646))-35
            green = min(segment(x,y,700,304,700,430)-20, math.hypot(x-700,y-292)-55)
            for d, color in [(stroke,(230,242,218)), (green,(167,213,141))]:
                mix = max(0, min(1, .5-d/scale))
                rgb = [round(a*(1-mix)+b*mix) for a,b in zip(rgb,color)]
            rows.extend((*rgb, round(alpha*255)))
    def chunk(kind, data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(rows,9))+chunk(b'IEND',b'')

sizes = [16,32,48,64,128,256,512,1024]
images = {size: png(size) for size in sizes}
Path('desktop/icons/icon.png').write_bytes(images[512])
Path('public/prbot.png').write_bytes(images[512])
entries, payload, offset = [], [], 6+16*6
for size in sizes[:6]:
    data=images[size]
    entries.append(struct.pack('<BBBBHHII',size%256,size%256,0,0,1,32,len(data),offset))
    payload.append(data); offset+=len(data)
Path('desktop/icons/icon.ico').write_bytes(struct.pack('<HHH',0,1,len(entries))+b''.join(entries+payload))
parts=[]
for size, kind in [(16,b'icp4'),(32,b'icp5'),(64,b'icp6'),(128,b'ic07'),(256,b'ic08'),(512,b'ic09'),(1024,b'ic10')]:
    data=images[size]; parts.append(kind+struct.pack('>I',len(data)+8)+data)
body=b''.join(parts)
Path('desktop/icons/icon.icns').write_bytes(b'icns'+struct.pack('>I',len(body)+8)+body)
