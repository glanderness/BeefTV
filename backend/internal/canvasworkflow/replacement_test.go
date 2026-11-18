package canvasworkflow

import "testing"

func TestCharacterReplacementOperationUsesSeparateTypedInputs(t *testing.T) {
	op := OperationByID("video.replace-character")
	if op.ID == "" || op.OutputType != "video" || len(op.Inputs) != 2 {
		t.Fatalf("missing reusable replacement operation: %+v", op)
	}
	if op.Inputs[0].ID != "video" || op.Inputs[0].MediaType != "video" || !op.Inputs[0].Required || op.Inputs[0].Multiple {
		t.Fatalf("source video must be a single required input: %+v", op.Inputs[0])
	}
	if op.Inputs[1].ID != "character" || op.Inputs[1].MediaType != "image" || !op.Inputs[1].Required || op.Inputs[1].Multiple {
		t.Fatalf("identity must be a separate required image: %+v", op.Inputs[1])
	}
}

func TestCharacterReplacementRejectsUnboundedOrDifferentModel(t *testing.T) {
	for _, config := range []map[string]any{
		{"modelOption": "beefapi::seedance-2.5"},
		{"modelOption": "beefapi::seedance-2.0-fast", "maxSegments": 0},
		{"modelOption": "beefapi::seedance-2.0-fast", "maxSegments": 101},
		{"modelOption": "beefapi::seedance-2.0-fast", "maxSegments": 1.5},
	} {
		if err := ValidateOperation(Node{ID: "replace", MediaType: "video", OperationID: "video.replace-character", OperationVersion: 1, Config: config}); err == nil {
			t.Fatalf("accepted unsafe replacement config: %+v", config)
		}
	}
	if err := ValidateOperation(Node{ID: "replace", MediaType: "video", OperationID: "video.replace-character", OperationVersion: 1, Config: map[string]any{"modelOption": "beefapi::seedance-2.0-fast"}}); err != nil {
		t.Fatalf("valid fast-only operation rejected: %v", err)
	}
}
