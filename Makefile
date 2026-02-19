NAME    := cursor-price-tracking
VERSION := 0.0.1
VSIX    := $(NAME)-$(VERSION).vsix

TRACKING_DIR := .cursor-cost-tracking

.PHONY: setup compile package install uninstall clean reinstall init-tracking

setup:
	npm install
	npm install -g @vscode/vsce

compile:
	npm run compile

package: compile
	vsce package

install: package
	cursor --install-extension $(VSIX)

uninstall:
	cursor --uninstall-extension Ittipong.$(NAME)

reinstall: uninstall install

init-tracking:
	mkdir -p $(TRACKING_DIR)
	@echo "Created $(TRACKING_DIR)/ — the extension will populate it on next refresh."

clean:
	rm -f $(VSIX)
	rm -rf out
