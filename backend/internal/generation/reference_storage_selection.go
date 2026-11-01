package generation

import "context"

func withReferenceStorage(ctx context.Context, config Config) context.Context {
	runtime, ok := RuntimeFromContext(ctx)
	if ok && runtime.SelectReferenceStorage != nil {
		if storage := runtime.SelectReferenceStorage(config); storage != nil {
			runtime.ReferenceStorage = storage
			return WithRuntime(ctx, runtime)
		}
	}
	return ctx
}
