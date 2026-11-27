package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"golang.org/x/net/websocket"
)

func exercise() error {
	port, err := strconv.ParseUint(os.Getenv("PROBE_RELAY_PORT"), 10, 16)
	if err != nil || port == 0 {
		return errors.New("invalid loopback relay port")
	}
	config, err := websocket.NewConfig(fmt.Sprintf("ws://127.0.0.1:%d/probe", port), os.Getenv("PROBE_BROWSER_ORIGIN"))
	if err != nil {
		return errors.New("invalid fixture config")
	}
	config.Protocol = []string{"probe.v1", os.Getenv("PROBE_AGENT_GRANT")}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	conn, err := config.DialContext(ctx)
	if err != nil {
		return errors.New("fixture agent handshake failed")
	}
	defer conn.Close()
	if len(config.Protocol) != 1 || config.Protocol[0] != "probe.v1" {
		return errors.New("unexpected negotiated protocol")
	}
	conn.MaxPayloadBytes = 512
	if err := conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return errors.New("cannot set fixture I/O deadline")
	}
	fmt.Println("ready")
	codec := websocket.Codec{Unmarshal: func(data []byte, kind byte, _ any) error {
		if kind != websocket.BinaryFrame || !bytes.Equal(data, []byte{0, 127, 128, 255}) {
			return errors.New("unexpected browser fixture bytes")
		}
		return nil
	}}
	if err := codec.Receive(conn, nil); err != nil {
		return errors.New("fixture agent did not receive the expected binary request")
	}
	if err := websocket.Message.Send(conn, []byte{254, 0, 19}); err != nil {
		return errors.New("fixture agent could not send the binary response")
	}
	var extra []byte
	if !errors.Is(websocket.Message.Receive(conn, &extra), io.EOF) {
		return errors.New("fixture agent did not observe EOF after browser close")
	}
	return nil
}

func main() {
	if err := exercise(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
