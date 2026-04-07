#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs('icons', exist_ok=True)

for size in [192, 512]:
    img = Image.new('RGB', (size, size), color='#0f0f0f')
    draw = ImageDraw.Draw(img)
    
    # Draw a simple receipt icon
    margin = size // 8
    w, h = size - 2*margin, size - 2*margin
    
    # Receipt body
    rect_color = '#1a1a1a'
    draw.rounded_rectangle([margin, margin, margin+w, margin+h], radius=size//16, fill=rect_color, outline='#c8f060', width=max(2, size//64))
    
    # Lines on receipt
    line_color = '#c8f060'
    line_x1 = margin + w//5
    line_x2 = margin + w - w//5
    line_y_start = margin + h//4
    line_step = h // 6
    
    for i in range(4):
        y = line_y_start + i * line_step
        lw = max(2, size//80)
        if i == 3:
            draw.line([line_x1, y, line_x1 + (line_x2 - line_x1) * 2 // 3, y], fill=line_color, width=lw*2)
        else:
            draw.line([line_x1, y, line_x2, y], fill=line_color, width=lw)
    
    img.save(f'icons/icon-{size}.png')
    print(f'Generated icon-{size}.png')

print('Icons generated!')
