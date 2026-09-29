from PIL import Image
img = Image.open('logo.png')
# Get bounding box of non-transparent pixels
bbox = img.getbbox()
if bbox:
    cropped = img.crop(bbox)
    cropped.save('logo.png')
    print("Cropped from", img.size, "to", cropped.size)
else:
    print("No non-transparent pixels found")
