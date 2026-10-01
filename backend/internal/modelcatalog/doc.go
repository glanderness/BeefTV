// Package modelcatalog is the authoritative model catalog, capability, and
// channel-configuration domain.
//
// UI, Agent, and ordinary generation must invoke these rules. This package
// must not import internal/app. Persistence, HTTP catalog fetch, protocol
// plugin registration, and generation task lifecycle stay outside.
package modelcatalog
