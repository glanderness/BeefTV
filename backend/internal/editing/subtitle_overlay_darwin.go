//go:build darwin && cgo

package editing

/*
#cgo LDFLAGS: -framework CoreGraphics -framework CoreText -framework CoreFoundation
#include <CoreGraphics/CoreGraphics.h>
#include <CoreText/CoreText.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>

static int renderSubtitleRGBA(const char *utf8Text, int width, int height, double fontSize, int marginX, int marginY, unsigned char *buf) {
	if (!utf8Text || width <= 0 || height <= 0 || !buf) {
		return -1;
	}
	CFStringRef fullStr = CFStringCreateWithCString(kCFAllocatorDefault, utf8Text, kCFStringEncodingUTF8);
	if (!fullStr) {
		return -2;
	}
	CTFontRef font = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, (CGFloat)fontSize, NULL);
	if (!font) {
		CFRelease(fullStr);
		return -3;
	}
	CFTypeRef keys[] = { kCTFontAttributeName, kCTForegroundColorFromContextAttributeName };
	CFTypeRef values[] = { font, kCFBooleanTrue };
	CFDictionaryRef attrs = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

	CFArrayRef paragraphs = CFStringCreateArrayBySeparatingStrings(kCFAllocatorDefault, fullStr, CFSTR("\n"));
	CFMutableArrayRef lines = CFArrayCreateMutable(kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
	double maxLineWidth = (double)(width - 2 * marginX);
	if (maxLineWidth < 1.0) {
		maxLineWidth = 1.0;
	}

	CFIndex paraCount = paragraphs ? CFArrayGetCount(paragraphs) : 0;
	for (CFIndex i = 0; i < paraCount; i++) {
		CFStringRef para = (CFStringRef)CFArrayGetValueAtIndex(paragraphs, i);
		CFIndex paraLen = CFStringGetLength(para);
		if (paraLen == 0) {
			CFAttributedStringRef emptyAttr = CFAttributedStringCreate(kCFAllocatorDefault, CFSTR(" "), attrs);
			CTLineRef emptyLine = CTLineCreateWithAttributedString(emptyAttr);
			CFArrayAppendValue(lines, emptyLine);
			CFRelease(emptyLine);
			CFRelease(emptyAttr);
			continue;
		}
		CFAttributedStringRef attrStr = CFAttributedStringCreate(kCFAllocatorDefault, para, attrs);
		CTTypesetterRef typesetter = CTTypesetterCreateWithAttributedString(attrStr);
		CFIndex start = 0;
		while (start < paraLen) {
			CFIndex count = CTTypesetterSuggestClusterBreak(typesetter, start, maxLineWidth);
			if (count <= 0) {
				count = 1;
			}
			CTLineRef line = CTTypesetterCreateLine(typesetter, CFRangeMake(start, count));
			CFArrayAppendValue(lines, line);
			CFRelease(line);
			start += count;
		}
		CFRelease(typesetter);
		CFRelease(attrStr);
	}

	CFIndex lineCount = CFArrayGetCount(lines);
	double lineStep = fontSize * 1.35;
	if ((double)lineCount * lineStep > (double)height * 0.8) {
		CFRelease(lines);
		if (paragraphs) CFRelease(paragraphs);
		CFRelease(attrs);
		CFRelease(font);
		CFRelease(fullStr);
		return -4;
	}

	CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
	CGContextRef ctx = CGBitmapContextCreate(buf, (size_t)width, (size_t)height, 8, (size_t)(width * 4), colorSpace, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
	CGColorSpaceRelease(colorSpace);
	if (!ctx) {
		CFRelease(lines);
		if (paragraphs) CFRelease(paragraphs);
		CFRelease(attrs);
		CFRelease(font);
		CFRelease(fullStr);
		return -5;
	}

	CGContextSetShouldAntialias(ctx, true);
	CGContextSetShouldSmoothFonts(ctx, false);
	CGContextSetLineJoin(ctx, kCGLineJoinRound);
	CGContextSetLineCap(ctx, kCGLineCapRound);
	double strokeWidth = fontSize / 10.0;
	if (strokeWidth < 2.0) {
		strokeWidth = 2.0;
	}
	CGContextSetLineWidth(ctx, (CGFloat)strokeWidth);

	for (CFIndex idx = 0; idx < lineCount; idx++) {
		CTLineRef line = (CTLineRef)CFArrayGetValueAtIndex(lines, idx);
		CGFloat ascent = 0, descent = 0, leading = 0;
		double typoWidth = CTLineGetTypographicBounds(line, &ascent, &descent, &leading);
		double x = ((double)width - typoWidth) / 2.0;
		if (x < (double)marginX * 0.5) {
			x = (double)marginX * 0.5;
		}
		double y = (double)marginY + (double)(lineCount - 1 - idx) * lineStep + (double)descent;

		CGContextSetTextDrawingMode(ctx, kCGTextStroke);
		CGContextSetRGBStrokeColor(ctx, 0.0, 0.0, 0.0, 1.0);
		CGContextSetTextPosition(ctx, (CGFloat)x, (CGFloat)y);
		CTLineDraw(line, ctx);

		CGContextSetTextDrawingMode(ctx, kCGTextFill);
		CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0);
		CGContextSetTextPosition(ctx, (CGFloat)x, (CGFloat)y);
		CTLineDraw(line, ctx);
	}

	CGContextRelease(ctx);
	CFRelease(lines);
	if (paragraphs) CFRelease(paragraphs);
	CFRelease(attrs);
	CFRelease(font);
	CFRelease(fullStr);
	return 0;
}
*/
import "C"

import (
	"fmt"
	"image"
	"math"
	"strings"
	"unsafe"
)

func rasterizeSubtitleFrame(text string, width, height int) (image.Image, error) {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	fontSize := math.Max(1, math.Round(math.Min(float64(height)/24.0, float64(width)/18.0)))
	marginX := max(1, int(math.Round(float64(width)*0.08)))
	marginY := max(1, int(math.Round(float64(height)*0.07)))

	pix := make([]byte, width*height*4)
	cText := C.CString(normalized)
	defer C.free(unsafe.Pointer(cText))

	rc := C.renderSubtitleRGBA(
		cText,
		C.int(width),
		C.int(height),
		C.double(fontSize),
		C.int(marginX),
		C.int(marginY),
		(*C.uchar)(unsafe.Pointer(&pix[0])),
	)
	if rc == -4 {
		return nil, fmt.Errorf("字幕过长，请拆分后导出")
	}
	if rc != 0 {
		return nil, fmt.Errorf("渲染字幕图层失败（code=%d）", int(rc))
	}
	return &image.RGBA{
		Pix:    pix,
		Stride: width * 4,
		Rect:   image.Rect(0, 0, width, height),
	}, nil
}
