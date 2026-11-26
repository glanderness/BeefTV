package canvas

const (
	seedreamLayerSourceGap = 96.0
	seedreamLayerColumnGap = 44.0
	seedreamLayerRowGap    = 56.0
	seedreamLayerMinEdge   = 24.0
)

// The input edge identifies the image on the canvas, independently of the
// provider's output metadata. Ambiguous inputs are left in their existing layout.
func seedreamLayerSource(doc map[string]any, rootID string) map[string]any {
	connections, _ := doc["connections"].([]any)
	var source map[string]any
	for _, raw := range connections {
		edge, _ := raw.(map[string]any)
		from := nodeString(edge, "fromNodeId")
		if from == rootID || nodeString(edge, "toNodeId") != rootID {
			continue
		}
		node := findCanvasNode(doc, from)
		if canvasNodeType(node) != "image" {
			continue
		}
		if source != nil && nodeString(source, "id") != from {
			return nil
		}
		source = node
	}
	return source
}

// Reserve an entire grid before placing any layer so individual collisions
// cannot break the reading order. Keep node creation and edges in one revision.
func arrangeSeedreamLayerBatch(doc, source map[string]any, layers []map[string]any) {
	sourceID := nodeString(source, "id")
	connections, _ := doc["connections"].([]any)
	mapped := map[string]bool{}
	for _, raw := range connections {
		edge, _ := raw.(map[string]any)
		if nodeString(edge, "fromNodeId") == sourceID {
			mapped[nodeString(edge, "toNodeId")] = true
		}
	}

	moving := make([]map[string]any, 0, len(layers))
	movingIDs := map[string]bool{}
	cellWidth, cellHeight := 0.0, 0.0
	for _, node := range layers {
		id := nodeString(node, "id")
		if !mapped[id] {
			connections = append(connections, map[string]any{"id": "seedream-layer-" + id, "fromNodeId": sourceID, "toNodeId": id})
			mapped[id] = true
		}
		meta := nodeMetadata(node)
		if locked, _ := meta["locked"].(bool); locked {
			continue
		}
		width, height := seedreamLayerCardSize(node, meta)
		node["width"], node["height"] = width, height
		cellWidth, cellHeight = max(cellWidth, width), max(cellHeight, height)
		moving = append(moving, node)
		movingIDs[id] = true
	}
	doc["connections"] = connections
	if len(moving) == 0 {
		return
	}

	columns := min(2, len(moving))
	if len(moving) >= 5 {
		columns = 3
	}
	rows := (len(moving) + columns - 1) / columns
	width := float64(columns)*(cellWidth+seedreamLayerColumnGap) - seedreamLayerColumnGap
	height := float64(rows)*(cellHeight+seedreamLayerRowGap) - seedreamLayerRowGap
	obstacles := make([]any, 0, len(canvasDocNodes(doc)))
	for _, raw := range canvasDocNodes(doc) {
		node, _ := raw.(map[string]any)
		if !movingIDs[nodeString(node, "id")] {
			obstacles = append(obstacles, raw)
		}
	}
	sx, sy := seedreamNodePosition(source)
	x, y := seedreamLayerGridOrigin(obstacles, sx+seedreamNumber(source, "width", 340)+seedreamLayerSourceGap, sy, width, height)
	for i, node := range moving {
		node["position"] = map[string]any{
			"x": x + float64(i%columns)*(cellWidth+seedreamLayerColumnGap),
			"y": y + float64(i/columns)*(cellHeight+seedreamLayerRowGap),
		}
	}
}

func seedreamLayerCardSize(node, meta map[string]any) (float64, float64) {
	width := seedreamNumber(node, "width", 340)
	height := seedreamNumber(node, "height", 240)
	if flag, _ := meta["manualSize"].(bool); flag {
		return width, height
	}
	if flag, _ := meta["freeResize"].(bool); flag {
		return width, height
	}
	width = max(seedreamLayerMinEdge, min(width, 420))
	height = max(seedreamLayerMinEdge, min(height, 300))
	naturalWidth := seedreamNumber(meta, "naturalWidth", width)
	naturalHeight := seedreamNumber(meta, "naturalHeight", height)
	if naturalWidth <= 0 || naturalHeight <= 0 {
		return width, height
	}
	scale := min(width/naturalWidth, height/naturalHeight)
	if naturalWidth*scale < seedreamLayerMinEdge || naturalHeight*scale < seedreamLayerMinEdge {
		return width, height
	}
	return naturalWidth * scale, naturalHeight * scale
}

func seedreamLayerGridOrigin(nodes []any, x, y, width, height float64) (float64, float64) {
	// A placement at any obstacle's right or bottom edge is a candidate.
	// Prefer the nearest clear candidate along the original row or column.
	bestX, bestY := x, y
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		nx, ny := seedreamNodePosition(node)
		bestX = max(bestX, nx+seedreamNumber(node, "width", 340)+seedreamLayerColumnGap)
		bestY = max(bestY, ny+seedreamNumber(node, "height", 240)+seedreamLayerRowGap)
	}
	if !seedreamPositionOccupied(nodes, x, y, width, height) {
		return x, y
	}
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		nx, ny := seedreamNodePosition(node)
		right := nx + seedreamNumber(node, "width", 340) + seedreamLayerColumnGap
		below := ny + seedreamNumber(node, "height", 240) + seedreamLayerRowGap
		if right >= x && right < bestX && !seedreamPositionOccupied(nodes, right, y, width, height) {
			bestX = right
		}
		if below >= y && below < bestY && !seedreamPositionOccupied(nodes, x, below, width, height) {
			bestY = below
		}
	}
	if bestY-y < bestX-x {
		return x, bestY
	}
	return bestX, y
}
