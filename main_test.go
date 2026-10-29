package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func mockResponse(body string) *http.Response {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestConnectAndResourceOperations(t *testing.T) {
	var requests []string
	a := &app{path: filepath.Join(t.TempDir(), "config.json"), client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/api" {
			return mockResponse(`[{"success":{"username":"secret"}}]`), nil
		}
		if r.Header.Get("hue-application-key") != "secret" {
			t.Error("missing application key")
		}
		return mockResponse(`{"errors":[],"data":[]}`), nil
	})}}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost:8080/api/"+path, strings.NewReader(body))
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		a.api(w, r)
		return w
	}
	if w := request("POST", "connect", `{"bridge":"192.168.1.10"}`); w.Code != 200 {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	file, err := os.ReadFile(a.path)
	if err != nil {
		t.Fatal(err)
	}
	var saved config
	if err := json.Unmarshal(file, &saved); err != nil || saved.Key != "secret" {
		t.Fatalf("bad config: %s", file)
	}
	if w := request("PUT", "grouped_light/abc-123", `{"on":{"on":true}}`); w.Code != 200 {
		t.Fatalf("group control: %s", w.Body.String())
	}
	if w := request("POST", "scene", `{"metadata":{"name":"Evening"}}`); w.Code != 200 {
		t.Fatalf("scene: %s", w.Body.String())
	}
	if w := request("GET", "device/abc", ""); w.Code != 404 {
		t.Fatalf("unexpected proxy access: %d", w.Code)
	}
	if w := request("POST", "disconnect", `{}`); w.Code != 200 {
		t.Fatalf("disconnect: %s", w.Body.String())
	}
	if _, err := os.Stat(a.path); !os.IsNotExist(err) {
		t.Fatal("config was not removed")
	}
	if a.config.Key != "" {
		t.Fatal("key remains in memory")
	}
	if len(requests) != 4 {
		t.Fatalf("unexpected bridge requests: %v", requests)
	}
}

func TestBridgeErrorsAndAddressValidation(t *testing.T) {
	a := &app{client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return mockResponse(`{"errors":[{"description":"light unavailable"}],"data":[]}`), nil
	})}}
	if _, err := a.bridge(config{Bridge: "8.8.8.8", Key: "key"}, "GET", "/clip/v2/resource", nil); err == nil {
		t.Fatal("public bridge address accepted")
	}
	if _, err := a.bridge(config{Bridge: "192.168.1.5", Key: "key"}, "GET", "/clip/v2/resource", nil); err == nil || err.Error() != "light unavailable" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBrowserSecurity(t *testing.T) {
	h := browserSecurity(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, tc := range []struct {
		host, origin string
		want         int
	}{
		{"localhost:6002", "http://localhost:6002", 204},
		{"192.168.1.10:6002", "http://192.168.1.10:6002", 204},
		{"HUE.EXAMPLE.COM:6002", "http://hue.example.com:6002", 204},
		{"any.example", "", 204},
		{"any.example", "https://any.example", 204},
		{"hue.example.com:6002", "http://evil.example:6002", 403},
		{"localhost:6002", "https://evil.example", 403},
	} {
		r := httptest.NewRequest("GET", "http://localhost:6002/", nil)
		r.Host = tc.host
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("host %q origin %q: got %d", tc.host, tc.origin, w.Code)
		}
	}
}
