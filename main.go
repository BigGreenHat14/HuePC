package main

import (
	"bytes"
	"crypto/tls"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var assets embed.FS

type config struct {
	Bridge string `json:"bridge"`
	Key    string `json:"key"`
}

type app struct {
	mu     sync.RWMutex
	config config
	path   string
	client *http.Client
}

var resourceID = regexp.MustCompile(`^[a-zA-Z0-9-]{1,64}$`)

func main() {
	dir, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	a := &app{path: filepath.Join(dir, "huepc", "config.json"), client: &http.Client{
		Timeout: 8 * time.Second,
		// Hue bridges use a self-signed certificate. Requests are restricted to a
		// user-selected private IP address; the application key never leaves it.
		Transport:     &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	if b, err := os.ReadFile(a.path); err == nil {
		_ = json.Unmarshal(b, &a.config)
	}
	web, err := fs.Sub(assets, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", a.api)
	mux.Handle("/", http.FileServer(http.FS(web)))
	server := &http.Server{Addr: "0.0.0.0:6002", Handler: localOnly(mux), ReadHeaderTimeout: 5 * time.Second}
	log.Println("HuePC is listening on 0.0.0.0:6002 (use http://127.0.0.1:6002 or this computer's IP address)")
	log.Fatal(server.ListenAndServe())
}

// Accept literal addresses of this connection (or localhost on loopback),
// preventing DNS rebinding while allowing access from other machines.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, port, err := net.SplitHostPort(r.Host)
		local, ok := r.Context().Value(http.LocalAddrContextKey).(*net.TCPAddr)
		validHost := false
		if err == nil && ok && port == "6002" {
			if strings.EqualFold(host, "localhost") {
				validHost = local.IP.IsLoopback()
			} else if ip := net.ParseIP(host); ip != nil {
				validHost = ip.Equal(local.IP)
			}
		}
		if !validHost {
			http.Error(w, "Invalid host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Scheme != "http" || !strings.EqualFold(u.Host, r.Host) {
				http.Error(w, "Invalid origin", http.StatusForbidden)
				return
			}
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, err error) {
	respond(w, status, map[string]string{"error": err.Error()})
}

func readJSON(r *http.Request, v any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("Expected JSON")
	}
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func privateIP(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && (ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

func (a *app) api(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/")
	if path == "status" && r.Method == http.MethodGet {
		a.mu.RLock()
		c := a.config
		a.mu.RUnlock()
		respond(w, 200, map[string]any{"configured": c.Bridge != "" && c.Key != "", "bridge": c.Bridge})
		return
	}
	if path == "discover" && r.Method == http.MethodGet {
		client := &http.Client{Timeout: 8 * time.Second}
		resp, err := client.Get("https://discovery.meethue.com/")
		if err != nil {
			fail(w, 502, fmt.Errorf("Discovery unavailable; enter your bridge IP manually"))
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			fail(w, 502, errors.New("Discovery unavailable; enter your bridge IP manually"))
			return
		}
		var bridges []struct {
			ID string `json:"id"`
			IP string `json:"internalipaddress"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&bridges); err != nil {
			fail(w, 502, errors.New("Invalid discovery response"))
			return
		}
		respond(w, 200, bridges)
		return
	}
	if path == "connect" && r.Method == http.MethodPost {
		var input struct {
			Bridge string `json:"bridge"`
		}
		if err := readJSON(r, &input); err != nil {
			fail(w, 400, err)
			return
		}
		input.Bridge = strings.TrimSpace(input.Bridge)
		if !privateIP(input.Bridge) {
			fail(w, 400, errors.New("Enter a private network IP address"))
			return
		}
		body := strings.NewReader(`{"devicetype":"huepc#webapp"}`)
		resp, err := a.client.Post("http://"+net.JoinHostPort(input.Bridge, "80")+"/api", "application/json", body)
		if err != nil {
			fail(w, 502, errors.New("Could not reach the bridge. Check its IP and your network."))
			return
		}
		defer resp.Body.Close()
		var result []struct {
			Success struct {
				Username string `json:"username"`
			} `json:"success"`
			Error struct {
				Description string `json:"description"`
			} `json:"error"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil || len(result) == 0 {
			fail(w, 502, errors.New("Invalid response from bridge"))
			return
		}
		if result[0].Success.Username == "" {
			msg := result[0].Error.Description
			if msg == "" {
				msg = "Bridge did not authorize the app"
			}
			fail(w, 400, errors.New(msg+". Press the bridge button and try again."))
			return
		}
		c := config{Bridge: input.Bridge, Key: result[0].Success.Username}
		if _, err := a.bridge(c, "GET", "/clip/v2/resource/bridge", nil); err != nil {
			fail(w, 502, fmt.Errorf("Connected, but v2 API verification failed: %w", err))
			return
		}
		if err := os.MkdirAll(filepath.Dir(a.path), 0700); err != nil {
			fail(w, 500, err)
			return
		}
		b, _ := json.Marshal(c)
		if err := os.WriteFile(a.path, b, 0600); err != nil {
			fail(w, 500, err)
			return
		}
		a.mu.Lock()
		a.config = c
		a.mu.Unlock()
		respond(w, 200, map[string]bool{"ok": true})
		return
	}
	if path == "disconnect" && r.Method == http.MethodPost {
		var input struct{}
		if err := readJSON(r, &input); err != nil {
			fail(w, 400, err)
			return
		}
		a.mu.Lock()
		if err := os.Remove(a.path); err != nil && !os.IsNotExist(err) {
			a.mu.Unlock()
			fail(w, 500, err)
			return
		}
		a.config = config{}
		a.mu.Unlock()
		respond(w, 200, map[string]bool{"ok": true})
		return
	}
	// Only these resource operations are exposed, not a general-purpose proxy.
	parts := strings.Split(path, "/")
	bridgePath := ""
	if path == "resources" && r.Method == "GET" {
		bridgePath = "/clip/v2/resource"
	}
	if len(parts) == 1 && (parts[0] == "room" || parts[0] == "scene") && r.Method == "POST" {
		bridgePath = "/clip/v2/resource/" + parts[0]
	}
	if len(parts) == 2 && resourceID.MatchString(parts[1]) {
		if (parts[0] == "light" || parts[0] == "grouped_light" || parts[0] == "room" || parts[0] == "scene") && r.Method == "PUT" {
			bridgePath = "/clip/v2/resource/" + path
		}
		if (parts[0] == "room" || parts[0] == "scene") && r.Method == "DELETE" {
			bridgePath = "/clip/v2/resource/" + path
		}
	}
	if bridgePath == "" {
		fail(w, 404, errors.New("Not found"))
		return
	}
	a.mu.RLock()
	c := a.config
	a.mu.RUnlock()
	if c.Bridge == "" || c.Key == "" {
		fail(w, 400, errors.New("Connect a bridge first"))
		return
	}
	var body []byte
	if r.Method == "POST" || r.Method == "PUT" {
		var value json.RawMessage
		if err := readJSON(r, &value); err != nil {
			fail(w, 400, err)
			return
		}
		body = value
	}
	data, err := a.bridge(c, r.Method, bridgePath, body)
	if err != nil {
		fail(w, 502, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func (a *app) bridge(c config, method, path string, body []byte) ([]byte, error) {
	if !privateIP(c.Bridge) {
		return nil, errors.New("Invalid bridge address")
	}
	req, err := http.NewRequest(method, "https://"+net.JoinHostPort(c.Bridge, "443")+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("hue-application-key", c.Key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, errors.New("Could not reach the bridge. Make sure it is online.")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	var result struct {
		Errors []struct {
			Description string `json:"description"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, errors.New("Invalid response from bridge")
	}
	if len(result.Errors) > 0 {
		return nil, errors.New(result.Errors[0].Description)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Bridge returned HTTP %d", resp.StatusCode)
	}
	return data, nil
}
