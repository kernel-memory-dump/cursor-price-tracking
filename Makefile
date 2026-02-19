NAME    := cursor-price-tracking
VERSION := 0.0.1
VSIX    := $(NAME)-$(VERSION).vsix

.PHONY: compile package install uninstall clean reinstall

compile:
	npm run compile

package: compile
	vsce package

install: package
	cursor --install-extension $(VSIX)

uninstall:
	cursor --uninstall-extension Ittipong.$(NAME)

reinstall: uninstall install

clean:
	rm -f $(VSIX)
	rm -rf out
